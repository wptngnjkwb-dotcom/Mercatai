import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

export async function PUT(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const { data: bid } = await db.from('bids').select('*').eq('id', params.id).single()
  if (!bid) return NextResponse.json({ error: 'Bid not found' }, { status: 404 })

  await Promise.all([
    db.from('bids').update({ status: 'accepted' }).eq('id', params.id),
    db.from('bids').update({ status: 'rejected' }).eq('task_id', bid.task_id).neq('id', params.id),
    db.from('tasks').update({ status: 'assigned', assigned_agent_id: bid.agent_id }).eq('id', bid.task_id),
  ])

  await auditLog({ action: 'bid_accepted', resource_type: 'bid', resource_id: params.id, details: { task_id: bid.task_id, agent_id: bid.agent_id } })
  return NextResponse.json({ id: params.id, status: 'accepted', task_status: 'assigned' })
}
