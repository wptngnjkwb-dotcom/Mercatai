import { NextRequest, NextResponse } from 'next/server'
import { resolveApiClient } from '@/lib/server/affiliate'
import { registerOAuthApp, VALID_SCOPES } from '@/lib/server/oauth'
import { getSupabase } from '@/lib/server/supabase'

// Rate limit: max 5 OAuth app registrations per IP per hour (prevent spam)
const oauthAppRateLimit = new Map<string, { count: number; resetAt: number }>()
function checkOAuthRegisterLimit(ip: string): boolean {
  const now = Date.now()
  const entry = oauthAppRateLimit.get(ip)
  if (entry && now < entry.resetAt) {
    if (entry.count >= 5) return false
    entry.count++
  } else {
    oauthAppRateLimit.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 })
  }
  return true
}

/**
 * POST /api/v1/developer/oauth-apps
 * Register a new OAuth application.
 * Requires mct_ API key (optional but ties the app to a developer account).
 *
 * Body: { name, description?, redirect_uris: string[] }
 * Returns: { oauth_client_id, client_secret } — secret shown only once!
 *
 * GET /api/v1/developer/oauth-apps
 * List OAuth apps owned by the authenticated client.
 */

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!checkOAuthRegisterLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded — max 5 OAuth apps per hour' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const { name, description, redirect_uris } = body

  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return NextResponse.json({ error: 'redirect_uris must be a non-empty array of HTTPS URLs' }, { status: 400 })
  }

  // Allow http://localhost for development
  const invalidUris = redirect_uris.filter(
    (u: string) => !u.startsWith('https://') && !u.startsWith('http://localhost')
  )
  if (invalidUris.length > 0) {
    return NextResponse.json({ error: `Invalid redirect_uris (must be https:// or localhost): ${invalidUris.join(', ')}` }, { status: 400 })
  }

  const apiClient = await resolveApiClient(request.headers.get('authorization'))

  try {
    const result = await registerOAuthApp({
      name,
      description,
      redirectUris: redirect_uris,
      ownerApiClientId: apiClient?.id,
    })

    return NextResponse.json({
      ...result,
      name,
      redirect_uris,
      allowed_scopes: [...VALID_SCOPES],
      authorize_url: 'https://mercatai.eu/oauth/authorize',
      token_url: 'https://mercatai.eu/api/oauth/token',
      _note: 'Save client_secret now — shown only once!',
    }, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const apiClient = await resolveApiClient(request.headers.get('authorization'))
  if (!apiClient) {
    return NextResponse.json({ error: 'Unauthorized — provide mct_ API key' }, { status: 401 })
  }

  const db = getSupabase()
  const { data, error } = await db
    .from('oauth_apps')
    .select('id, oauth_client_id, name, description, redirect_uris, allowed_scopes, is_active, created_at')
    .eq('owner_api_client_id', apiClient.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ oauth_apps: data ?? [] })
}
