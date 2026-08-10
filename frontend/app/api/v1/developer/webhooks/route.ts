/**
 * POST /api/v1/developer/webhooks  — register a webhook endpoint
 * GET  /api/v1/developer/webhooks  — list webhooks for a client
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { resolveApiClient } from '@/lib/server/affiliate'
import { validateWebhookUrl } from '@/lib/server/webhookSecurity'

const VALID_EVENTS = [
  'task.created',
  'task.delivered',
  'task.completed',
  'task.disputed',
  'bid.accepted',
  'bid.rejected',
]

export async function POST(request: NextRequest) {
  try {
    const caller = await resolveApiClient(request.headers.get('authorization'))
    if (!caller) {
      return NextResponse.json({ error: 'Authenticate with a Bearer API key to register a webhook' }, { status: 401 })
    }
    if (!caller.scopes?.includes('webhooks:write')) {
      return NextResponse.json({ error: 'API key is missing the webhooks:write scope' }, { status: 403 })
    }

    const body = await request.json()
    const { client_id, url, events } = body

    if (!client_id || !url || !events) {
      return NextResponse.json({ error: 'client_id, url and events are required' }, { status: 400 })
    }

    if (client_id !== caller.id) {
      return NextResponse.json({ error: 'client_id must match the authenticated API client' }, { status: 403 })
    }

    // Validate URL — rejects malformed URLs and SSRF targets (private/internal addresses)
    const urlCheck = await validateWebhookUrl(url)
    if (!urlCheck.ok) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 })
    }

    // Validate events
    const invalidEvents = events.filter((e: string) => !VALID_EVENTS.includes(e))
    if (invalidEvents.length > 0) {
      return NextResponse.json({
        error: `Invalid events: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`,
      }, { status: 400 })
    }

    const db = getSupabase()

    // Verify client exists
    const { data: client } = await db
      .from('api_clients')
      .select('id')
      .eq('id', client_id)
      .eq('is_active', true)
      .single()

    if (!client) {
      return NextResponse.json({ error: 'API client not found' }, { status: 404 })
    }

    // Generate webhook signing secret
    const secret = 'whsec_' + randomBytes(32).toString('hex')

    const { data: webhook, error } = await db
      .from('webhooks')
      .insert({
        client_id,
        url,
        events,
        secret,
        is_active: true,
        failure_count: 0,
      })
      .select('id, url, events, is_active, created_at')
      .single()

    if (error) throw error

    await auditLog({
      action: 'webhook_registered',
      resource_type: 'webhook',
      resource_id: webhook.id,
      details: { client_id, url, events },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })

    return NextResponse.json({
      ...webhook,
      secret,
      secret_note: 'Save this secret — use it to verify webhook signatures (X-Mercatai-Signature header).',
    }, { status: 201 })

  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Webhook registration failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const caller = await resolveApiClient(request.headers.get('authorization'))
  if (!caller) {
    return NextResponse.json({ error: 'Authenticate with a Bearer API key to list webhooks' }, { status: 401 })
  }

  const db = getSupabase()

  // Always scoped to the authenticated client — a client_id query param
  // would let one client enumerate another client's webhooks.
  const { data, error } = await db
    .from('webhooks')
    .select('id, url, events, is_active, last_fired_at, failure_count, created_at')
    .eq('client_id', caller.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhooks: data })
}
