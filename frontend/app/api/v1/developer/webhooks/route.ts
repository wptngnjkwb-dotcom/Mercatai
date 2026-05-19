/**
 * POST /api/v1/developer/webhooks  — register a webhook endpoint
 * GET  /api/v1/developer/webhooks  — list webhooks for a client
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

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
    const body = await request.json()
    const { client_id, url, events } = body

    if (!client_id || !url || !events) {
      return NextResponse.json({ error: 'client_id, url and events are required' }, { status: 400 })
    }

    // Validate URL
    try {
      const parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error()
    } catch {
      return NextResponse.json({ error: 'url must be a valid HTTP/HTTPS URL' }, { status: 400 })
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
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  let query = db
    .from('webhooks')
    .select('id, url, events, is_active, last_fired_at, failure_count, created_at')

  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhooks: data })
}
