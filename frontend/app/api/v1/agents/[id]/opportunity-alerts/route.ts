import { NextRequest, NextResponse } from 'next/server'
import { getTokenFromRequest } from '@/lib/server/auth'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

const CATEGORIES = ['research', 'content', 'code_review', 'procurement', 'data_analysis', 'translation', 'finance'] as const
const LOCALES = ['en', 'cs', 'de', 'es'] as const

function authorize(token: any, agentId: string): boolean {
  return !!token && (token.agent_id === agentId || token.tier === 'admin')
}

function normalizeList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const normalized = Array.from(new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)))
  if (normalized.some((item) => item.length > 80)) return null
  return normalized
}

function maskEmail(value: string): string {
  const [local, domain] = value.split('@')
  if (!local || !domain) return 'registered operator email'
  return `${local.slice(0, 2)}***@${domain}`
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const db = getSupabase()
  const [{ data: agent, error: agentError }, { data: subscription, error: subscriptionError }] = await Promise.all([
    db.from('agents').select('owner_email').eq('id', params.id).maybeSingle(),
    db.from('opportunity_alert_subscriptions').select('categories,capabilities,locale,is_active,created_at,updated_at').eq('agent_id', params.id).maybeSingle(),
  ])
  if (agentError || subscriptionError) return NextResponse.json({ error: 'Could not load opportunity-alert settings' }, { status: 500 })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  return NextResponse.json({
    enabled: subscription?.is_active === true,
    categories: subscription?.categories ?? [],
    capabilities: subscription?.capabilities ?? [],
    locale: subscription?.locale ?? 'en',
    notification_email: agent.owner_email ? maskEmail(agent.owner_email) : null,
  })
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const categories = normalizeList(body.categories ?? [], 7)
  const capabilities = normalizeList(body.capabilities ?? [], 30)
  const locale = typeof body.locale === 'string' && LOCALES.includes(body.locale as any) ? body.locale : null
  if (!categories || categories.some((category) => !CATEGORIES.includes(category as any))) {
    return NextResponse.json({ error: `categories must contain only: ${CATEGORIES.join(', ')}` }, { status: 400 })
  }
  if (!capabilities) return NextResponse.json({ error: 'capabilities must be an array of at most 30 short strings' }, { status: 400 })
  if (!locale) return NextResponse.json({ error: `locale must be one of: ${LOCALES.join(', ')}` }, { status: 400 })

  const db = getSupabase()
  const { data: agent, error: agentError } = await db
    .from('agents')
    .select('id,owner_email,is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (agentError) return NextResponse.json({ error: 'Could not verify agent' }, { status: 500 })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  if (!agent.is_active) return NextResponse.json({ error: 'Inactive agents cannot enable opportunity alerts' }, { status: 409 })
  if (!agent.owner_email) return NextResponse.json({ error: 'A registered operator email is required for email alerts' }, { status: 409 })

  const { data, error } = await db
    .from('opportunity_alert_subscriptions')
    .upsert({
      agent_id: params.id,
      categories,
      capabilities,
      locale,
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'agent_id' })
    .select('categories,capabilities,locale,is_active')
    .single()
  if (error) return NextResponse.json({ error: 'Could not save opportunity-alert settings' }, { status: 500 })
  await auditLog({
    agent_id: params.id,
    action: 'opportunity_alerts_enabled',
    resource_type: 'agent',
    resource_id: params.id,
    details: { categories, capabilities, locale },
    ip_address: request.headers.get('x-forwarded-for') ?? undefined,
  })
  return NextResponse.json({
    enabled: data.is_active,
    categories: data.categories,
    capabilities: data.capabilities,
    locale: data.locale,
    notification_email: maskEmail(agent.owner_email),
    funding_notice: 'Task alerts announce bidding opportunities, not funded work. Begin only when funding_status=funded and execution_authorized=true.',
  })
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const db = getSupabase()
  const { error } = await db
    .from('opportunity_alert_subscriptions')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('agent_id', params.id)
  if (error) return NextResponse.json({ error: 'Could not disable opportunity alerts' }, { status: 500 })
  await auditLog({
    agent_id: params.id,
    action: 'opportunity_alerts_disabled',
    resource_type: 'agent',
    resource_id: params.id,
    ip_address: request.headers.get('x-forwarded-for') ?? undefined,
  })
  return NextResponse.json({ disabled: true })
}
