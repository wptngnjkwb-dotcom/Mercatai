import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

function authorize(token: any, agentId: string): boolean {
  return !!token && (token.agent_id === agentId || token.tier === 'admin')
}

/**
 * GET /api/v1/agents/:id/earnings
 * Agent-facing earnings: released payouts, pending (held) amounts, and a
 * per-task breakdown. Derived from transactions on tasks assigned to the agent.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = getSupabase()

  // Tasks assigned to this agent
  const { data: tasks, error: taskErr } = await db
    .from('tasks')
    .select('id, title, category, status, created_at')
    .eq('assigned_agent_id', params.id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (taskErr) return NextResponse.json({ error: taskErr.message }, { status: 500 })

  const taskList = tasks ?? []
  const taskIds = taskList.map(t => t.id)
  const taskMap = new Map(taskList.map(t => [t.id, t]))

  // Transactions for those tasks
  let txs: any[] = []
  if (taskIds.length > 0) {
    const { data: txData } = await db
      .from('transactions')
      .select('task_id, agent_payout_eur, gross_amount_eur, escrow_status, released_at')
      .in('task_id', taskIds)
    txs = txData ?? []
  }

  let released = 0
  let pending = 0
  const items = txs.map(tx => {
    const payout = Number(tx.agent_payout_eur ?? 0)
    if (tx.escrow_status === 'released') released += payout
    else if (tx.escrow_status === 'held') pending += payout
    const task = taskMap.get(tx.task_id)
    return {
      task_id: tx.task_id,
      task_title: task?.title ?? '—',
      category: task?.category ?? null,
      payout_eur: Math.round(payout * 100) / 100,
      gross_eur: Math.round(Number(tx.gross_amount_eur ?? 0) * 100) / 100,
      status: tx.escrow_status,
      released_at: tx.released_at ?? null,
    }
  }).sort((a, b) => (b.released_at ?? '').localeCompare(a.released_at ?? ''))

  const completedCount = taskList.filter(t => t.status === 'completed').length

  return NextResponse.json({
    summary: {
      total_released_eur: Math.round(released * 100) / 100,
      total_pending_eur: Math.round(pending * 100) / 100,
      lifetime_eur: Math.round((released + pending) * 100) / 100,
      tasks_assigned: taskList.length,
      tasks_completed: completedCount,
      avg_payout_eur: items.length > 0 ? Math.round((released + pending) / items.length * 100) / 100 : 0,
    },
    earnings: items,
    _note: 'Payouts are settled to your Stripe Connect account when the buyer approves the work.',
  })
}
