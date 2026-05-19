/**
 * OAuth 2.0 Authorization Code Flow utilities.
 *
 * Flow:
 *  1. Third-party registers OAuth app → gets oauth_client_id + client_secret
 *  2. User (agent) visits /oauth/authorize?client_id=oac_xxx&redirect_uri=...&scope=...&state=xxx
 *  3. Agent authenticates with agent_id + api_key → approves
 *  4. Mercatai redirects to redirect_uri?code=xxx&state=xxx
 *  5. Third-party POSTs code to /api/oauth/token → gets access_token (JWT 1h) + refresh_token (30d)
 *  6. Third-party calls API with Authorization: Bearer <access_token>
 */

import { randomBytes, createHash } from 'crypto'
import bcrypt from 'bcryptjs'
import { getSupabase } from './supabase'
import { signToken, verifyToken } from './auth'

export const VALID_SCOPES = ['tasks:read', 'agents:read', 'profile:read', 'bids:write', 'webhooks:write'] as const
export type OAuthScope = typeof VALID_SCOPES[number]

// ─── App registration ────────────────────────────────────────────────────────

export async function registerOAuthApp(params: {
  name: string
  description?: string
  redirectUris: string[]
  ownerApiClientId?: string
}): Promise<{ oauth_client_id: string; client_secret: string }> {
  const db = getSupabase()
  const oauthClientId = 'oac_' + randomBytes(16).toString('hex')
  const clientSecret  = 'oas_' + randomBytes(32).toString('hex')
  const secretHash    = await bcrypt.hash(clientSecret, 10)

  const { error } = await db.from('oauth_apps').insert({
    oauth_client_id: oauthClientId,
    client_secret_hash: secretHash,
    name: params.name,
    description: params.description ?? null,
    redirect_uris: params.redirectUris,
    owner_api_client_id: params.ownerApiClientId ?? null,
  })
  if (error) throw error

  return { oauth_client_id: oauthClientId, client_secret: clientSecret }
}

// ─── Verify OAuth app + redirect URI ─────────────────────────────────────────

export async function getOAuthApp(oauthClientId: string) {
  const db = getSupabase()
  const { data } = await db
    .from('oauth_apps')
    .select('id, oauth_client_id, name, description, redirect_uris, allowed_scopes, client_secret_hash')
    .eq('oauth_client_id', oauthClientId)
    .eq('is_active', true)
    .single()
  return data
}

export function isValidRedirectUri(app: { redirect_uris: string[] }, uri: string): boolean {
  return app.redirect_uris.includes(uri)
}

export function parseScopes(scopeStr: string): OAuthScope[] {
  const requested = scopeStr.split(/[\s,+]+/).filter(Boolean)
  return requested.filter(s => VALID_SCOPES.includes(s as OAuthScope)) as OAuthScope[]
}

// ─── Auth code ───────────────────────────────────────────────────────────────

export async function createAuthCode(params: {
  oauthAppId: string
  agentId: string
  scopes: string[]
  redirectUri: string
}): Promise<string> {
  const db = getSupabase()
  const code = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

  const { error } = await db.from('oauth_auth_codes').insert({
    code,
    oauth_app_id: params.oauthAppId,
    agent_id: params.agentId,
    scopes: params.scopes,
    redirect_uri: params.redirectUri,
    expires_at: expiresAt.toISOString(),
  })
  if (error) throw error
  return code
}

export async function consumeAuthCode(code: string, oauthAppId: string, redirectUri: string) {
  const db = getSupabase()
  const { data, error } = await db
    .from('oauth_auth_codes')
    .select('*')
    .eq('code', code)
    .eq('oauth_app_id', oauthAppId)
    .eq('redirect_uri', redirectUri)
    .eq('used', false)
    .single()

  if (error || !data) return null
  if (new Date(data.expires_at) < new Date()) return null

  // Mark as used (one-time)
  await db.from('oauth_auth_codes').update({ used: true }).eq('code', code)
  return data
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export async function issueTokens(params: {
  oauthAppId: string
  agentId: string
  agentStringId: string  // agent.agent_id (string) for JWT
  scopes: string[]
}) {
  // Access token — JWT, 1 hour
  const accessToken = await signToken({
    role: 'oauth',
    agent_id: params.agentStringId,
    agent_uuid: params.agentId,
    oauth_app_id: params.oauthAppId,
    scopes: params.scopes,
  }, '1h')

  // Refresh token — opaque, 30 days, stored as hash
  const refreshToken = 'oar_' + randomBytes(40).toString('hex')
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex')

  const db = getSupabase()
  await db.from('oauth_refresh_tokens').insert({
    token_hash: tokenHash,
    oauth_app_id: params.oauthAppId,
    agent_id: params.agentId,
    scopes: params.scopes,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  })

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: params.scopes.join(' '),
  }
}

export async function refreshAccessToken(refreshToken: string, oauthClientId: string, clientSecret: string) {
  if (!refreshToken.startsWith('oar_')) return null

  const tokenHash = createHash('sha256').update(refreshToken).digest('hex')
  const db = getSupabase()

  const { data: stored } = await db
    .from('oauth_refresh_tokens')
    .select('*, oauth_apps!inner(id, oauth_client_id, client_secret_hash)')
    .eq('token_hash', tokenHash)
    .eq('revoked', false)
    .single()

  if (!stored) return null
  if (new Date(stored.expires_at) < new Date()) return null

  // Verify client secret
  const app = (stored as any).oauth_apps
  if (app.oauth_client_id !== oauthClientId) return null
  const secretOk = await bcrypt.compare(clientSecret, app.client_secret_hash)
  if (!secretOk) return null

  // Get agent string id
  const { data: agent } = await db
    .from('agents')
    .select('agent_id')
    .eq('id', stored.agent_id)
    .single()
  if (!agent) return null

  // Issue new access token (refresh token stays valid)
  const accessToken = await signToken({
    role: 'oauth',
    agent_id: agent.agent_id,
    agent_uuid: stored.agent_id,
    oauth_app_id: app.id,
    scopes: stored.scopes,
  }, '1h')

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: stored.scopes.join(' '),
  }
}

// ─── Verify agent credentials (for authorize page) ────────────────────────────

export async function verifyAgentCredentials(agentStringId: string, apiKey: string): Promise<{ id: string; agent_id: string; display_name: string } | null> {
  const db = getSupabase()
  const { data: agent } = await db
    .from('agents')
    .select('id, agent_id, display_name, api_key_hash, is_active')
    .eq('agent_id', agentStringId)
    .single()

  if (!agent || !agent.is_active) return null
  const match = await bcrypt.compare(apiKey, agent.api_key_hash)
  if (!match) return null
  return { id: agent.id, agent_id: agent.agent_id, display_name: agent.display_name }
}
