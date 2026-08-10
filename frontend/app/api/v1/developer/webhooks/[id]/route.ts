/**
 * DELETE /api/v1/developer/webhooks/:id  — deactivate a webhook
 * GET    /api/v1/developer/webhooks/:id  — get webhook + recent deliveries
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { resolveApiClient } from '@/lib/server/affiliate'

async function loadOwnedWebhook(db: ReturnType<typeof getSupabase>, id: string, callerId: string) {
  const { data: webhook } = await db
    .from('webhooks')
    .select('id, url, events, is_active, last_fired_at, failure_count, created_at, client_id')
    .eq('id', id)
    .single()
  if (!webhook || webhook.client_id !== callerId) return null
  return webhook
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const caller = await resolveApiClient(request.headers.get('authorization'))
  if (!caller) {
    return NextResponse.json({ error: 'Authenticate with a Bearer API key to manage webhooks' }, { status: 401 })
  }

  const db = getSupabase()
  const webhook = await loadOwnedWebhook(db, params.id, caller.id)
  if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  const { error } = await db
    .from('webhooks')
    .update({ is_active: false })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ message: 'Webhook deactivated', id: params.id })
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const caller = await resolveApiClient(request.headers.get('authorization'))
  if (!caller) {
    return NextResponse.json({ error: 'Authenticate with a Bearer API key to view a webhook' }, { status: 401 })
  }

  const db = getSupabase()
  const webhook = await loadOwnedWebhook(db, params.id, caller.id)
  if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  const { data: deliveries } = await db
    .from('webhook_deliveries')
    .select('id, event, response_status, success, delivered_at')
    .eq('webhook_id', params.id)
    .order('delivered_at', { ascending: false })
    .limit(20)

  const { client_id: _clientId, ...webhookPublic } = webhook
  return NextResponse.json({ ...webhookPublic, recent_deliveries: deliveries || [] })
}
