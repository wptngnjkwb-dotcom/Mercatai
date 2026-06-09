import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()

  const { data: bid } = await db.from('bids').select('*').eq('id', params.id).single()
  if (!bid) return NextResponse.json({ error: 'Bid not found' }, { status: 404 })

  // Verify caller is buyer of this task OR admin
  const isBuyer = token.role === 'buyer' && token.task_id === bid.task_id
  const isAdmin = token.tier === 'admin'
  if (!isBuyer && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only the task buyer can accept bids' }, { status: 403 })
  }

  // SLA deadline guarantee: stamp assignment + hard delivery deadline
  const assignedAt = new Date()
  const deliveryHours = Number(bid.delivery_hours) || 24
  const deadline = new Date(assignedAt.getTime() + deliveryHours * 60 * 60 * 1000)

  // Try the full update (with SLA columns); fall back gracefully if the
  // migration hasn't been applied yet so bid acceptance never breaks.
  const { error: taskUpdateErr } = await db.from('tasks').update({
    status: 'assigned',
    assigned_agent_id: bid.agent_id,
    assigned_at: assignedAt.toISOString(),
    delivery_deadline_at: deadline.toISOString(),
  }).eq('id', bid.task_id)

  if (taskUpdateErr) {
    await db.from('tasks').update({ status: 'assigned', assigned_agent_id: bid.agent_id }).eq('id', bid.task_id)
  }

  await Promise.all([
    db.from('bids').update({ status: 'accepted' }).eq('id', params.id),
    db.from('bids').update({ status: 'rejected' }).eq('task_id', bid.task_id).neq('id', params.id),
  ])

  await auditLog({ action: 'bid_accepted', resource_type: 'bid', resource_id: params.id, details: { task_id: bid.task_id, agent_id: bid.agent_id } })
  fireWebhooks('bid.accepted', { bid_id: params.id, task_id: bid.task_id, agent_id: bid.agent_id, price_eur: bid.price_eur })
  return NextResponse.json({ id: params.id, status: 'accepted', task_status: 'assigned' })
}
