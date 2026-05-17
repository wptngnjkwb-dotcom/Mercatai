import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

function scoreBid(bid: { price_eur: number; delivery_hours: number; agent_reputation: number }, task: { budget_max_eur: number; deadline_hours: number }) {
  const rep = bid.agent_reputation / 100
  const price = task.budget_max_eur > 0 ? Math.max(0, 1 - bid.price_eur / task.budget_max_eur) : 0
  const speed = task.deadline_hours > 0 ? Math.max(0, 1 - bid.delivery_hours / task.deadline_hours) : 0
  return rep * 0.35 + price * 0.20 + speed * 0.15
}

export async function POST(request: NextRequest) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const { task_id, agent_id, price_eur, delivery_hours, approach_summary } = body

    if (!task_id || !agent_id || !price_eur || !delivery_hours) {
      return NextResponse.json({ error: 'task_id, agent_id, price_eur and delivery_hours are required' }, { status: 400 })
    }

    const db = getSupabase()

    const [{ data: task }, { data: agent }] = await Promise.all([
      db.from('tasks').select('*').eq('id', task_id).single(),
      db.from('agents').select('*').eq('id', agent_id).single(),
    ])

    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    if (!agent.is_active) return NextResponse.json({ error: 'Agent not approved' }, { status: 403 })
    if (!['open', 'bidding'].includes(task.status)) return NextResponse.json({ error: 'Task not accepting bids' }, { status: 400 })
    if (price_eur > task.budget_max_eur) return NextResponse.json({ error: 'Bid exceeds task budget' }, { status: 400 })

    const score = scoreBid(
      { price_eur, delivery_hours, agent_reputation: agent.reputation_score },
      { budget_max_eur: task.budget_max_eur, deadline_hours: task.deadline_hours }
    )

    const { data: bid, error } = await db
      .from('bids')
      .insert({ task_id, agent_id, price_eur, delivery_hours, approach_summary: approach_summary || '', score, status: 'pending' })
      .select()
      .single()

    if (error) throw error

    // Move task to bidding state
    if (task.status === 'open') {
      await db.from('tasks').update({ status: 'bidding' }).eq('id', task_id)
    }

    await auditLog({ action: 'bid_submitted', resource_type: 'bid', resource_id: bid.id, agent_id, details: { task_id, price_eur, score } })
    return NextResponse.json(bid, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to submit bid' }, { status: 500 })
  }
}
