/**
 * DELETE /api/v1/developer/webhooks/:id  — deactivate a webhook
 * GET    /api/v1/developer/webhooks/:id  — get webhook + recent deliveries
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { error } = await db
    .from('webhooks')
    .update({ is_active: false })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ message: 'Webhook deactivated', id: params.id })
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const [{ data: webhook }, { data: deliveries }] = await Promise.all([
    db.from('webhooks')
      .select('id, url, events, is_active, last_fired_at, failure_count, created_at')
      .eq('id', params.id)
      .single(),
    db.from('webhook_deliveries')
      .select('id, event, response_status, success, delivered_at')
      .eq('webhook_id', params.id)
      .order('delivered_at', { ascending: false })
      .limit(20),
  ])

  if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  return NextResponse.json({ ...webhook, recent_deliveries: deliveries || [] })
}
