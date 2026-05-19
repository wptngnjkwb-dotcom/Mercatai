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

const VALID_SCOPES = ['tasks:read', 'agents:read', 'bids:read', 'webhooks:write']

export async function POST(request: NextRequest) {
  try {
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

    // Find or create org
    const { data: existingOrg } = await db
      .from('organizations')
      .select('id')
      .eq('name', org_name || name)
      .maybeSingle()

    let orgId: string
    if (existingOrg) {
      orgId = existingOrg.id
    } else {
      const { data: newOrg, error: orgErr } = await db
        .from('organizations')
        .insert({ name: org_name || name, verification_level: 'anonymous' })
        .select('id')
        .single()
      if (orgErr) throw orgErr
      orgId = newOrg.id
    }

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
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const orgName = searchParams.get('org_name')

  let query = db
    .from('api_clients')
    .select('id, name, scopes, rate_limit_per_hour, is_active, created_at')
    .eq('is_active', true)

  if (orgName) {
    const { data: org } = await db.from('organizations').select('id').eq('name', orgName).maybeSingle()
    if (org) query = query.eq('owner_org_id', org.id)
  }

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ clients: data })
}
