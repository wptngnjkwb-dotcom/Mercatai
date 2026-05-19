import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import {
  getOAuthApp,
  consumeAuthCode,
  issueTokens,
  refreshAccessToken,
} from '@/lib/server/oauth'
import { getSupabase } from '@/lib/server/supabase'

/**
 * POST /api/oauth/token
 * Standard OAuth 2.0 token endpoint.
 *
 * Supports:
 *   grant_type=authorization_code  → exchange code for access + refresh token
 *   grant_type=refresh_token       → get new access token
 *
 * Accepts both application/json and application/x-www-form-urlencoded.
 */
export async function POST(request: NextRequest) {
  // Parse body — support both JSON and form-encoded
  const contentType = request.headers.get('content-type') ?? ''
  let body: Record<string, string>

  if (contentType.includes('application/json')) {
    body = await request.json().catch(() => ({}))
  } else {
    const text = await request.text()
    body = Object.fromEntries(new URLSearchParams(text))
  }

  const { grant_type, code, redirect_uri, client_id, client_secret, refresh_token } = body

  if (!grant_type) {
    return oauthError('invalid_request', 'grant_type is required')
  }

  // ── Authorization Code ──────────────────────────────────────────────────────
  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri || !client_id || !client_secret) {
      return oauthError('invalid_request', 'code, redirect_uri, client_id and client_secret are required')
    }

    const app = await getOAuthApp(client_id)
    if (!app) return oauthError('invalid_client', 'OAuth app not found')

    const secretOk = await bcrypt.compare(client_secret, app.client_secret_hash)
    if (!secretOk) return oauthError('invalid_client', 'Invalid client_secret')

    const authCode = await consumeAuthCode(code, app.id, redirect_uri)
    if (!authCode) return oauthError('invalid_grant', 'Authorization code is invalid, expired or already used')

    // Fetch agent string ID for JWT
    const db = getSupabase()
    const { data: agent } = await db.from('agents').select('agent_id').eq('id', authCode.agent_id).single()
    if (!agent) return oauthError('server_error', 'Agent not found')

    const tokens = await issueTokens({
      oauthAppId: app.id,
      agentId: authCode.agent_id,
      agentStringId: agent.agent_id,
      scopes: authCode.scopes,
    })

    return NextResponse.json(tokens, {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    })
  }

  // ── Refresh Token ───────────────────────────────────────────────────────────
  if (grant_type === 'refresh_token') {
    if (!refresh_token || !client_id || !client_secret) {
      return oauthError('invalid_request', 'refresh_token, client_id and client_secret are required')
    }

    const result = await refreshAccessToken(refresh_token, client_id, client_secret)
    if (!result) return oauthError('invalid_grant', 'Refresh token is invalid, expired or revoked')

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    })
  }

  return oauthError('unsupported_grant_type', `grant_type '${grant_type}' is not supported`)
}

function oauthError(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status })
}
