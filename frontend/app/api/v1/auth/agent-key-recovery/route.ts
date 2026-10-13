import { createHash, randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { clientIp, isRateLimited, recordAttempt } from '@/lib/server/rateLimit'
import { sendAgentApiKeyRecoveryOrThrow } from '@/lib/server/email'

const GENERIC_RESPONSE = {
  accepted: true,
  message: 'If the agent id and contact email match an active account, Mercatai will send a short-lived recovery link.',
}
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  if (await isRateLimited({ action: 'agent_key_recovery_requested', ip, windowMinutes: 60, maxEvents: 5 })) {
    // Keep the same public shape for matching and non-matching identities.
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
  }

  const body = await request.json().catch(() => ({}))
  const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  await recordAttempt('agent_key_recovery_requested', ip, { valid_shape: !!agentId && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) })

  if (!agentId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
  }

  const db = getSupabase()
  const { data: agent } = await db
    .from('agents')
    .select('id,agent_id,owner_email,is_active')
    .eq('agent_id', agentId)
    .maybeSingle()

  if (!agent || !agent.is_active || agent.owner_email?.trim().toLowerCase() !== email) {
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
  }

  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const { data: recovery, error } = await db
    .from('agent_api_key_recovery_tokens')
    .insert({ agent_id: agent.id, token_hash: tokenHash, expires_at: expiresAt })
    .select('id')
    .single()

  if (error || !recovery) {
    console.error('[agent-key-recovery] token creation failed')
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
  }

  try {
    const providerId = await sendAgentApiKeyRecoveryOrThrow({
      to: email,
      agentId: agent.agent_id,
      recoveryToken: rawToken,
    })
    await auditLog({
      action: 'agent_key_recovery_email_sent',
      resource_type: 'agent',
      resource_id: agent.id,
      agent_id: agent.id,
      details: { recovery_id: recovery.id, provider_id: providerId, expires_at: expiresAt },
      ip_address: ip ?? undefined,
    })
  } catch (error) {
    // The public response stays enumeration-safe. Mark the undelivered token
    // unusable so a later provider retry cannot unexpectedly revive it.
    await db.from('agent_api_key_recovery_tokens').update({ used_at: new Date().toISOString() }).eq('id', recovery.id)
    console.error('[agent-key-recovery] email delivery failed', error instanceof Error ? error.message : error)
  }

  return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
}
