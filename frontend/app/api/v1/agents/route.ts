import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { isRateLimited, clientIp } from '@/lib/server/rateLimit'

export async function POST(request: NextRequest) {
  try {
    // Auto-approval makes registration a spam target — cap per IP.
    const ip = clientIp(request)
    if (await isRateLimited({ action: 'agent_registered', ip, windowMinutes: 60, maxEvents: 5 })) {
      return NextResponse.json({ error: 'Too many registrations from this address — try again later' }, { status: 429 })
    }

    const body = await request.json()
    const { agent_id, display_name, description, capabilities, languages, owner_email, gdpr_consent, organization_join_token } = body

    if (!agent_id || !display_name) {
      return NextResponse.json({ error: 'agent_id and display_name are required' }, { status: 400 })
    }
    if (!gdpr_consent) {
      return NextResponse.json({ error: 'GDPR consent is required to register' }, { status: 400 })
    }
    // Already documented as required in the OpenAPI spec (RegisterAgentRequest)
    // and needed for real — it becomes the Stripe Connect account's email at
    // onboarding time (see stripe-onboard/route.ts), so a missing or invalid
    // one only surfaces as a confusing Stripe failure much later otherwise.
    const normalizedOwnerEmail = typeof owner_email === 'string' ? owner_email.trim().toLowerCase() : ''
    if (!normalizedOwnerEmail || !normalizedOwnerEmail.includes('@') || !normalizedOwnerEmail.split('@')[1]?.includes('.')) {
      return NextResponse.json({ error: 'owner_email is required and must be a valid email address' }, { status: 400 })
    }

    const db = getSupabase()

    // owner_email is a contact field, never proof of organization
    // membership — knowing an email address doesn't mean owning it, so
    // looking up "or create" an org by it let anyone register an agent
    // under any existing organization (including another company's) just
    // by typing their public contact email. Two agents belong to the same
    // organization only if the second one presents the first one's
    // organization_join_token, generated once and returned only at the
    // moment a brand new organization is created (see below) — never
    // re-derivable from owner_email or anything else guessable.
    let orgId: string
    let organizationJoinToken: string | null = null
    if (organization_join_token) {
      const [lookupId, secret] = String(organization_join_token).split('.')
      const invalid = () => NextResponse.json({ error: 'Invalid organization_join_token' }, { status: 400 })
      if (!lookupId || !secret) return invalid()

      const { data: joinOrg } = await db
        .from('organizations')
        .select('id, is_suspended, join_token_secret_hash')
        .eq('join_token_lookup_id', lookupId)
        .maybeSingle()
      if (!joinOrg || !joinOrg.join_token_secret_hash) return invalid()
      if (!(await bcrypt.compare(secret, joinOrg.join_token_secret_hash))) return invalid()
      if (joinOrg.is_suspended) {
        return NextResponse.json({ error: 'This organization has been suspended and cannot accept new agents' }, { status: 403 })
      }
      orgId = joinOrg.id
    } else {
      const { data: newOrg, error: orgErr } = await db
        .from('organizations')
        .insert({ name: normalizedOwnerEmail, verification_level: 'anonymous' })
        .select('id')
        .single()
      if (orgErr) throw orgErr
      orgId = newOrg.id

      // Generated once, for the org's first agent only — shown once in
      // the response below, only its bcrypt hash is ever stored. Format
      // "<lookup_id>.<secret>" mirrors agents.api_key_hash's own
      // lookup-then-compare pattern (see POST /auth/login): lookupId is
      // plaintext and indexed for a direct query, secret is the only part
      // that needs a bcrypt compare.
      const lookupId = randomBytes(16).toString('hex')
      const secret = randomBytes(16).toString('hex')
      const secretHash = await bcrypt.hash(secret, 10)
      const { error: joinTokenErr } = await db
        .from('organizations')
        .update({ join_token_lookup_id: lookupId, join_token_secret_hash: secretHash })
        .eq('id', orgId)
      if (joinTokenErr) throw joinTokenErr
      organizationJoinToken = `${lookupId}.${secret}`
    }

    const apiKey = randomBytes(32).toString('hex')  // 64-char hex key
    const apiKeyHash = await bcrypt.hash(apiKey, 10)

    const { data: agent, error } = await db
      .from('agents')
      .insert({
        agent_id,
        owner_org_id: orgId,
        owner_email: normalizedOwnerEmail,
        display_name,
        description: description || '',
        capabilities: capabilities || [],
        languages: languages || ['en'],
        verification_level: 'anonymous',
        reputation_score: 50.0,
        tier: 1,
        free_tasks_remaining: 10,
        // Auto-approved on registration so agents can start bidding immediately.
        // Risk is bounded: new agents carry a low Mercatai Score, and buyers
        // choose the winning bid and pay only on approval (pay-on-approval).
        is_active: true,
        gdpr_consent_at: new Date().toISOString(),
        api_key_hash: apiKeyHash,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Agent ID already exists' }, { status: 409 })
      throw error
    }

    await auditLog({
      action: 'agent_registered',
      resource_type: 'agent',
      resource_id: agent.id,
      agent_id: agent.id,
      details: { agent_id, display_name },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })

    // WARNING: api_key (and organization_join_token, if present) are shown
    // only once — only their hashes are stored, never the values themselves.
    return NextResponse.json({
      id: agent.id,
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      status: 'active',
      message: 'Agent registered and active — you can log in and start bidding.',
      api_key: apiKey,
      ...(organizationJoinToken ? {
        organization_join_token: organizationJoinToken,
        organization_join_token_note: 'Save this — share it with teammates registering more agents under this same organization. Shown only once.',
      } : {}),
    }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const capability = searchParams.get('capability')
  const language = searchParams.get('language')

  let query = db.from('agents').select('id,agent_id,display_name,description,capabilities,languages,reputation_score,tier,success_rate,total_tasks_completed').eq('is_active', true)
  if (capability) query = query.contains('capabilities', [capability])
  if (language) query = query.contains('languages', [language])

  const { data, error } = await query.order('reputation_score', { ascending: false }).limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ agents: data })
}
