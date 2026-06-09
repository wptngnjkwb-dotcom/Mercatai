import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { applyReputationEvent } from '@/lib/server/reputation'

/**
 * SLA deadline guarantee — Vercel Cron (hourly).
 *
 * Auto-refunds the buyer when an assigned agent blows past the delivery
 * deadline without submitting work. This is the backbone of the "Deadline
 * guarantee" trust promise shown to buyers.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getSupabase()
  const now = new Date().toISOString()

  // Held transactions whose task is still undelivered and past its deadline
  let overdue: any[] = []
  try {
    const { data, error } = await db
      .from('transactions')
      .select('*, tasks!inner(id, status, assigned_agent_id, delivery_deadline_at, title)')
      .eq('escrow_status', 'held')
      .in('tasks.status', ['assigned', 'in_progress'])
      .lt('tasks.delivery_deadline_at', now)
    if (error) {
      // Likely the SLA columns are not migrated yet — nothing to do.
      return NextResponse.json({ refunded: 0, message: 'SLA tracking not available', detail: error.message })
    }
    overdue = data ?? []
  } catch (e) {
    return NextResponse.json({ refunded: 0, message: 'SLA check skipped', detail: String(e) })
  }

  if (overdue.length === 0) {
    return NextResponse.json({ refunded: 0, message: 'No overdue tasks found' })
  }

  const results: any[] = []

  for (const tx of overdue) {
    try {
      // Cancel the authorized Stripe payment (refund to buyer)
      if (process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
        const Stripe = (await import('stripe')).default
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
        await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id)
      }

      await db.from('transactions').update({ escrow_status: 'refunded' }).eq('id', tx.id)
      await db.from('tasks').update({ status: 'cancelled' }).eq('id', tx.task_id)

      // Penalize the agent's reputation for the missed deadline
      const agentId = tx.tasks?.assigned_agent_id
      if (agentId) {
        await applyReputationEvent(agentId, 'task_failed', tx.task_id).catch(() => {})
      }

      await auditLog({
        action: 'sla_auto_refund',
        resource_type: 'transaction',
        resource_id: tx.id,
        details: {
          task_id: tx.task_id,
          gross_amount_eur: tx.gross_amount_eur,
          reason: 'delivery_deadline_missed',
          deadline: tx.tasks?.delivery_deadline_at,
        },
      })

      results.push({ transaction_id: tx.id, task_id: tx.task_id, status: 'refunded' })
    } catch (err) {
      results.push({ transaction_id: tx.id, status: 'error', error: String(err) })
    }
  }

  return NextResponse.json({
    refunded: results.filter(r => r.status === 'refunded').length,
    results,
  })
}
