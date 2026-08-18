import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { signToken, verifyToken } from '@/lib/server/auth'
import { isRateLimited, recordAttempt, clientIp } from '@/lib/server/rateLimit'

/**
 * Exchange a refresh token (from /auth/login) for a new 15-minute access
 * token. The refresh token is sent in the body, not as a Bearer header —
 * it is not an access credential and getTokenFromRequest rejects it as one.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request)
    if (await isRateLimited({ action: 'refresh_failed', ip, windowMinutes: 15, maxEvents: 30 })) {
      return NextResponse.json({ error: 'Too many failed attempts — try again later', code: 'rate_limited' }, { status: 429 })
    }

    const { refresh_token } = await request.json().catch(() => ({}))
    if (!refresh_token || typeof refresh_token !== 'string') {
      return NextResponse.json({ error: 'refresh_token is required', code: 'missing_token' }, { status: 400 })
    }

    let payload
    try {
      payload = await verifyToken(refresh_token)
    } catch (err) {
      await recordAttempt('refresh_failed', ip, { reason: 'unverifiable' })
      const code = (err as { code?: string } | undefined)?.code
      return NextResponse.json(
        { error: code === 'ERR_JWT_EXPIRED' ? 'Refresh token expired — log in again' : 'Invalid refresh token', code: code === 'ERR_JWT_EXPIRED' ? 'token_expired' : 'invalid_token' },
        { status: 401 },
      )
    }

    if (payload.type !== 'refresh' || typeof payload.agent_id !== 'string') {
      await recordAttempt('refresh_failed', ip, { reason: 'wrong_token_type' })
      return NextResponse.json({ error: 'Invalid refresh token', code: 'invalid_token' }, { status: 401 })
    }

    const db = getSupabase()
    const { data: agent } = await db.from('agents').select('id,agent_id,tier,is_active').eq('id', payload.agent_id).single()

    if (!agent) {
      await recordAttempt('refresh_failed', ip, { reason: 'agent_not_found', agent_id: payload.agent_id })
      return NextResponse.json({ error: 'Invalid refresh token', code: 'invalid_token' }, { status: 401 })
    }
    if (!agent.is_active) {
      await recordAttempt('refresh_failed', ip, { reason: 'agent_inactive', agent_id: agent.id })
      return NextResponse.json({ error: 'Agent is inactive' }, { status: 403 })
    }

    const accessToken = await signToken(
      { agent_id: agent.id, agent_slug: agent.agent_id, tier: agent.tier },
      '15m'
    )

    return NextResponse.json({ access_token: accessToken, token_type: 'bearer', expires_in: 900 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Token refresh failed' }, { status: 500 })
  }
}
