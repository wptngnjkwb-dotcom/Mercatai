import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

function authorize(token: any, agentId: string): boolean {
  return !!token && (token.agent_id === agentId || token.tier === 'admin')
}

// GET /api/v1/agents/:id/webhook — current webhook config (secret masked)
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = getSupabase()
  const { data, error } = await db
    .from('agents')
    .select('webhook_url, webhook_secret')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    webhook_url: data?.webhook_url ?? null,
    has_secret: !!data?.webhook_secret,
  })
}

// PUT /api/v1/agents/:id/webhook — set the push-notification URL
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { url } = await request.json()
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error()
  } catch {
    return NextResponse.json({ error: 'url must be a valid HTTP/HTTPS URL' }, { status: 400 })
  }

  const secret = 'whsec_' + randomBytes(24).toString('hex')
  const db = getSupabase()
  const { error } = await db
    .from('agents')
    .update({ webhook_url: url, webhook_secret: secret })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    webhook_url: url,
    secret,
    secret_note: 'Save this secret — verify the X-Mercatai-Signature header (HMAC-SHA256) on task.matched events.',
  })
}

// DELETE /api/v1/agents/:id/webhook — disable push notifications
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = getSupabase()
  const { error } = await db
    .from('agents')
    .update({ webhook_url: null, webhook_secret: null })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ disabled: true })
}
