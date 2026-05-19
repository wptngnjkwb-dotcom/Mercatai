import { NextRequest, NextResponse } from 'next/server'
import {
  getOAuthApp,
  isValidRedirectUri,
  parseScopes,
  verifyAgentCredentials,
  createAuthCode,
} from '@/lib/server/oauth'

/**
 * POST /api/oauth/authorize
 * Called by the /oauth/authorize page when agent approves access.
 *
 * Body (form-encoded or JSON):
 *   agent_id, api_key, oauth_client_id, redirect_uri, scope, state, action (approve|deny)
 *
 * Returns: { redirect_to: string } — frontend redirects the browser there
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') ?? ''
  let body: Record<string, string>

  if (contentType.includes('application/json')) {
    body = await request.json().catch(() => ({}))
  } else {
    const form = await request.formData().catch(() => new FormData())
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]))
  }

  const { agent_id, api_key, oauth_client_id, redirect_uri, scope, state, action } = body

  // Validate required params
  if (!oauth_client_id || !redirect_uri) {
    return NextResponse.json({ error: 'oauth_client_id and redirect_uri are required' }, { status: 400 })
  }

  const app = await getOAuthApp(oauth_client_id)
  if (!app) return NextResponse.json({ error: 'OAuth app not found or inactive' }, { status: 404 })

  if (!isValidRedirectUri(app, redirect_uri)) {
    return NextResponse.json({ error: 'redirect_uri not registered for this app' }, { status: 400 })
  }

  const stateParam = state ? `&state=${encodeURIComponent(state)}` : ''

  // User denied access
  if (action === 'deny') {
    return NextResponse.json({
      redirect_to: `${redirect_uri}?error=access_denied${stateParam}`,
    })
  }

  // Validate agent credentials
  if (!agent_id || !api_key) {
    return NextResponse.json({ error: 'agent_id and api_key are required' }, { status: 400 })
  }

  const agent = await verifyAgentCredentials(agent_id, api_key)
  if (!agent) {
    return NextResponse.json({ error: 'Invalid agent credentials' }, { status: 401 })
  }

  const scopes = parseScopes(scope ?? '')
  if (scopes.length === 0) {
    return NextResponse.json({ error: 'No valid scopes requested' }, { status: 400 })
  }

  const code = await createAuthCode({
    oauthAppId: app.id,
    agentId: agent.id,
    scopes,
    redirectUri: redirect_uri,
  })

  return NextResponse.json({
    redirect_to: `${redirect_uri}?code=${code}${stateParam}`,
  })
}
