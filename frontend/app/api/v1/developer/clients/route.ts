/**
 * POST /api/v1/developer/clients  — register a new API client (third-party app)
 * GET  /api/v1/developer/clients  — list your API clients
 *
 * Returns a plain-text API key once on creation — not stored, only hash kept.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { resolveApiClient } from '@/lib/server/affiliate'
import { isRateLimited, clientIp } from '@/lib/server/rateLimit'

const VALID_SCOPES = ['tasks:read', 'agents:read', 'bids:read', 'webhooks:write']

export async function POST(request: NextRequest) {
  try {
    // Unauthenticated, so unlimited here means unlimited organizations
    // and API keys — including a way to route around the per-key
    // metered-usage quota by just minting a new key. Same database-backed
    // limiter and window as agent registration.
    const ip = clientIp(request)
    if (await isRateLimited({ action: 'api_client_created', ip, windowMinutes: 60, maxEvents: 5 })) {
      return NextResponse.json({ error: 'Too many API client registrations from this address — try again later' }, { status: 429 })
    }

    const body = await request.json()
    const { name, scopes, org_name } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const requestedScopes: string[] = scopes || ['tasks:read', 'agents:read']
    const invalidScopes = requestedScopes.filter((s: string) => !VALID_SCOPES.includes(s))
    if (invalidScopes.length > 0) {
      return NextResponse.json({
        error: `Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`,
      }, { status: 400 })
    }

    const db = getSupabase()

    // org_name (or name, as a fallback label) is free text from the
    // request body — never an identity lookup key. This endpoint is
    // unauthenticated, so looking up "or create" by name would let anyone
    // type an existing organization's exact name and have their new API
    // client attached to it — including seeing that org's other clients
    // via GET /developer/clients, which is scoped by owner_org_id alone.
    // Same rule as POST /tasks and the hire route: every registration
    // gets a brand new organization row, even on a name collision.
    const { data: newOrg, error: orgErr } = await db
      .from('organizations')
      .insert({ name: org_name || name, verification_level: 'anonymous' })
      .select('id')
      .single()
    if (orgErr) throw orgErr
    const orgId: string = newOrg.id

    // Generate API key
    const apiKey = 'mct_' + randomBytes(32).toString('hex') // 68-char prefixed key
    const keyHash = await bcrypt.hash(apiKey, 10)

    const { data: client, error } = await db
      .from('api_clients')
      .insert({
        name,
        key_hash: keyHash,
        owner_org_id: orgId,
        scopes: requestedScopes,
        rate_limit_per_hour: 1000,
        is_active: true,
      })
      .select('id, name, scopes, rate_limit_per_hour, created_at')
      .single()

    if (error) throw error

    await auditLog({
      action: 'api_client_created',
      resource_type: 'api_client',
      resource_id: client.id,
      details: { name, scopes: requestedScopes },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })

    return NextResponse.json({
      ...client,
      api_key: apiKey,
      api_key_note: 'Save this key — it will not be shown again. Use as Bearer token.',
      api_key_prefix: 'mct_',
    }, { status: 201 })

  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Client creation failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const caller = await resolveApiClient(request.headers.get('authorization'))
  if (!caller) {
    return NextResponse.json({ error: 'Authenticate with a Bearer API key to list clients' }, { status: 401 })
  }

  const db = getSupabase()

  const { data: callerRecord } = await db
    .from('api_clients')
    .select('owner_org_id')
    .eq('id', caller.id)
    .single()

  if (!callerRecord?.owner_org_id) {
    return NextResponse.json({ clients: [] })
  }

  const { data, error } = await db
    .from('api_clients')
    .select('id, name, scopes, rate_limit_per_hour, is_active, created_at')
    .eq('is_active', true)
    .eq('owner_org_id', callerRecord.owner_org_id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ clients: data })
}
