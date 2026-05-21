import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { sendNewBid } from '@/lib/server/email'

function scoreBid(bid: { price_eur: number; delivery_hours: number; agent_reputation: number }, task: { budget_max_eur: number; deadline_hours: number }) {
  const rep = bid.agent_reputation / 100
  const price = task.budget_max_eur > 0 ? Math.max(0, 1 - bid.price_eur / task.budget_max_eur) : 0
  const speed = task.deadline_hours > 0 ? Math.max(0, 1 - bid.delivery_hours / task.deadline_hours) : 0
  // Weights: reputation 50%, price 30%, speed 20% — sum = 1.0
  return rep * 0.50 + price * 0.30 + speed * 0.20
}

export async function POST(request: NextRequest) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const { task_id, agent_id, price_eur, delivery_hours, approach_summary, sample_preview } = body

    if (!task_id || !agent_id || !price_eur || !delivery_hours) {
      return NextResponse.json({ error: 'task_id, agent_id, price_eur and delivery_hours are required' }, { status: 400 })
    }

    if (sample_preview && typeof sample_preview === 'string' && sample_preview.length > 1000) {
      return NextResponse.json({ error: 'sample_preview must be at most 1000 characters' }, { status: 400 })
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
      .insert({ task_id, agent_id, price_eur, delivery_hours, approach_summary: approach_summary || '', sample_preview: sample_preview || null, score, status: 'pending' })
      .select()
      .single()

    if (error) throw error

    // Move task to bidding state
    if (task.status === 'open') {
      await db.from('tasks').update({ status: 'bidding' }).eq('id', task_id)
    }

    await auditLog({ action: 'bid_submitted', resource_type: 'bid', resource_id: bid.id, agent_id, details: { task_id, price_eur, score } })

    // Email notification to buyer if they provided email (fire-and-forget)
    const { count: bidCount } = await db.from('bids').select('id', { count: 'exact', head: true }).eq('task_id', task_id)
    const buyerEmail = (task as any).buyer_email
    if (buyerEmail) {
      sendNewBid({
        to: buyerEmail,
        taskTitle: task.title,
        taskId: task_id,
        agentName: agent.display_name,
        priceEur: price_eur,
        deliveryHours: delivery_hours,
        totalBids: bidCount ?? 1,
      }).catch(console.error)
    }

    return NextResponse.json(bid, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to submit bid' }, { status: 500 })
  }
}
