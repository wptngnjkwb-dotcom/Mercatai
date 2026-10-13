import { createHash, randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { clientIp, isRateLimited, recordAttempt } from '@/lib/server/rateLimit'

export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  if (await isRateLimited({ action: 'agent_key_recovery_failed', ip, windowMinutes: 15, maxEvents: 10 })) {
    return NextResponse.json({ error: 'Too many invalid or expired recovery attempts — try again later' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const rawToken = typeof body.token === 'string' ? body.token.trim() : ''
  if (rawToken.length < 32 || rawToken.length > 512) {
    await recordAttempt('agent_key_recovery_failed', ip, { reason: 'invalid_shape' })
    return NextResponse.json({ error: 'Recovery link is invalid or expired' }, { status: 400 })
  }

  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const apiKey = randomBytes(32).toString('hex')
  const apiKeyHash = await bcrypt.hash(apiKey, 10)
  const db = getSupabase()
  const { data, error } = await db.rpc('consume_agent_api_key_recovery', {
    p_token_hash: tokenHash,
    p_new_api_key_hash: apiKeyHash,
  })
  const consumed = Array.isArray(data) ? data[0] : data

  if (error || !consumed) {
    await recordAttempt('agent_key_recovery_failed', ip, { reason: 'invalid_expired_or_used' })
    return NextResponse.json({ error: 'Recovery link is invalid or expired' }, { status: 400 })
  }

  await auditLog({
    action: 'agent_api_key_rotated',
    resource_type: 'agent',
    resource_id: consumed.agent_id,
    agent_id: consumed.agent_id,
    details: { auth_version: consumed.auth_version },
    ip_address: ip ?? undefined,
  })

  return NextResponse.json({
    agent_id: consumed.agent_slug,
    api_key: apiKey,
    api_key_note: 'Save this replacement API key now. It is shown only once; only its hash is stored.',
    old_key_revoked: true,
    old_refresh_tokens_revoked: true,
    old_oauth_refresh_tokens_revoked: true,
    prior_agent_access_tokens_expire_within_seconds: 900,
    prior_oauth_access_tokens_expire_within_seconds: 3600,
  })
}
