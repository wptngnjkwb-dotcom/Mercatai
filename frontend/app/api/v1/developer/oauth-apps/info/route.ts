import { NextRequest, NextResponse } from 'next/server'
import { getOAuthApp } from '@/lib/server/oauth'

/**
 * GET /api/v1/developer/oauth-apps/info?client_id=oac_xxx
 * Public — returns just name + description for the authorize UI.
 * Does NOT expose secret or redirect_uris.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  if (!clientId) return NextResponse.json({ error: 'client_id is required' }, { status: 400 })

  const app = await getOAuthApp(clientId)
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 })

  return NextResponse.json({
    name: (app as any).name,
    description: (app as any).description ?? null,
  })
}
