import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { agentIdentityForWebhook } from '@/lib/server/agentVisibility'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()

  const { data: bid, error: bidError } = await db
    .from('bids')
    .select('id,task_id')
    .eq('id', params.id)
    .single()
  if (bidError && bidError.code !== 'PGRST116') {
    return NextResponse.json({ error: 'Bid could not be loaded' }, { status: 500 })
  }
  if (!bid) return NextResponse.json({ error: 'Bid not found' }, { status: 404 })

  // Verify caller is buyer of this task OR admin
  const isBuyer = token.role === 'buyer' && token.task_id === bid.task_id
  const isAdmin = token.tier === 'admin'
  if (!isBuyer && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only the task buyer can accept bids' }, { status: 403 })
  }

  // The database locks the task first, then selects exactly one still-pending
  // bid. Task assignment and all bid statuses either commit together or roll
  // back together. Re-accepting a bid after funding or changing the payee is
  // therefore impossible even under concurrent requests.
  const { data, error } = await db.rpc('accept_task_bid', {
    p_bid_id: params.id,
    p_expected_task_id: bid.task_id,
  })
  if (error) {
    if (error.code === 'P0002') return NextResponse.json({ error: 'Bid or task not found' }, { status: 404 })
    if (error.code === 'P0001' || error.code === '23505') {
      return NextResponse.json({ error: 'This bid can no longer be selected for the current task state' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Bid selection could not be recorded' }, { status: 500 })
  }
  const accepted = Array.isArray(data) ? data[0] : data
  if (!accepted) return NextResponse.json({ error: 'Bid selection was not confirmed' }, { status: 500 })

  await auditLog({ action: 'bid_accepted', resource_type: 'bid', resource_id: params.id, details: { task_id: accepted.task_id, agent_id: accepted.agent_id } })
  // Third-party developer webhooks never learn a private agent's identity
  // — see frontend/lib/server/agentVisibility.ts. The audit log above is
  // internal, not public distribution, and keeps the real agent_id.
  fireWebhooks('bid.accepted', {
    bid_id: params.id,
    task_id: accepted.task_id,
    price_eur: accepted.price_eur,
    ...(await agentIdentityForWebhook(db, accepted.agent_id)),
  })
  return NextResponse.json({
    id: accepted.bid_id,
    status: 'accepted',
    task_status: accepted.task_status,
    assigned_at: accepted.assigned_at,
  })
}
