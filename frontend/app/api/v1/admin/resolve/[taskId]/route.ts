import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { applyReputationEvent } from '@/lib/server/reputation'

/**
 * Dispute resolution — the missing exit from the 'disputed' state.
 *
 * PUT { resolution: 'refund_buyer' | 'pay_agent', note?: string }
 *   refund_buyer → cancel the Stripe authorization, task → cancelled
 *   pay_agent    → capture the payment, task → completed
 */
export async function PUT(request: NextRequest, { params }: { params: { taskId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const { resolution, note } = body
  if (!['refund_buyer', 'pay_agent'].includes(resolution)) {
    return NextResponse.json({ error: "resolution must be 'refund_buyer' or 'pay_agent'" }, { status: 400 })
  }

  const db = getSupabase()

  const { data: task } = await db.from('tasks').select('*').eq('id', params.taskId).single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (task.status !== 'disputed') {
    return NextResponse.json({ error: 'Task is not disputed' }, { status: 400 })
  }

  const { data: tx } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .maybeSingle()

  const hasStripeIntent =
    process.env.STRIPE_SECRET_KEY && tx?.stripe_payment_intent_id?.startsWith('pi_')

  if (resolution === 'refund_buyer') {
    if (tx?.escrow_status === 'held' && hasStripeIntent) {
      try {
        const Stripe = (await import('stripe')).default
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
        await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return NextResponse.json({ error: `Stripe cancel failed: ${msg}` }, { status: 502 })
      }
    }
    if (tx) {
      await db.from('transactions').update({ escrow_status: 'refunded' }).eq('id', tx.id)
    }
    await db.from('tasks').update({ status: 'cancelled' }).eq('id', params.taskId)
  } else {
    if (tx?.escrow_status === 'held' && hasStripeIntent) {
      try {
        const Stripe = (await import('stripe')).default
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
        await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return NextResponse.json({ error: `Stripe capture failed: ${msg}` }, { status: 502 })
      }
    }
    if (tx) {
      await db.from('transactions')
        .update({ escrow_status: 'released', released_at: new Date().toISOString() })
        .eq('id', tx.id)
    }
    await db.from('tasks').update({ status: 'completed' }).eq('id', params.taskId)
    if (task.assigned_agent_id) {
      await applyReputationEvent(task.assigned_agent_id, 'task_completed', params.taskId)
    }
  }

  await auditLog({
    action: 'dispute_resolved',
    resource_type: 'task',
    resource_id: params.taskId,
    details: { resolution, note, transaction_id: tx?.id },
  })

  return NextResponse.json({
    task_id: params.taskId,
    resolution,
    status: resolution === 'refund_buyer' ? 'cancelled' : 'completed',
  })
}
