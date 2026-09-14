import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

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
  if (note !== undefined && (typeof note !== 'string' || note.trim().length > 1000)) {
    return NextResponse.json({ error: 'note must be text up to 1,000 characters' }, { status: 400 })
  }

  const db = getSupabase()

  const { data: task, error: taskError } = await db.from('tasks').select('*').eq('id', params.taskId).single()
  if (taskError && taskError.code !== 'PGRST116') return NextResponse.json({ error: 'Task could not be loaded' }, { status: 500 })
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (task.status !== 'disputed') {
    return NextResponse.json({ error: 'Task is not disputed' }, { status: 400 })
  }

  const { data: tx, error: txError } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (txError) return NextResponse.json({ error: 'Payment could not be loaded' }, { status: 500 })
  if (!tx || tx.escrow_status !== 'held') return NextResponse.json({ error: 'No funded payment found for this dispute' }, { status: 409 })
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  if (!tx.stripe_payment_intent_id?.startsWith('pi_')) return NextResponse.json({ error: 'Funded transaction has no valid Stripe payment reference' }, { status: 409 })

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  let intent
  try {
    intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
  } catch (err) {
    console.error('Stripe dispute lookup failed', err)
    return NextResponse.json({ error: 'Stripe payment could not be verified' }, { status: 502 })
  }

  if (resolution === 'refund_buyer') {
    try {
      if (intent.status === 'succeeded') {
        await stripe.refunds.create({
          payment_intent: tx.stripe_payment_intent_id,
          reverse_transfer: true,
          refund_application_fee: true,
        }, { idempotencyKey: `mercatai-admin-refund-${tx.id}` })
      } else if (intent.status === 'requires_capture') {
        await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id)
      } else if (intent.status === 'canceled') {
        // Retry after a successful Stripe cancellation and failed DB write.
      } else {
        return NextResponse.json({ error: `Stripe payment cannot be refunded from status ${intent.status}` }, { status: 409 })
      }
    } catch (err) {
      console.error('Stripe dispute refund failed', err)
      return NextResponse.json({ error: 'Stripe refund failed' }, { status: 502 })
    }
    const { data, error } = await db.rpc('finalize_task_refund', {
      p_task_id: params.taskId, p_transaction_id: tx.id,
      p_outcome: 'admin_dispute_refund', p_reason: typeof note === 'string' ? note.trim() : 'admin dispute resolution',
    })
    const result = Array.isArray(data) ? data[0] : data
    if (error || !result || result.task_status !== 'cancelled' || result.transaction_status !== 'refunded') {
      return NextResponse.json({ error: 'Stripe refund succeeded but database finalization must be retried' }, { status: 500 })
    }
  } else {
    try {
      if (intent.capture_method === 'manual' && intent.status === 'requires_capture') {
        await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
      } else if (intent.status !== 'succeeded') {
        return NextResponse.json({ error: `Stripe payment cannot be paid from status ${intent.status}` }, { status: 409 })
      }
    } catch (err) {
      console.error('Stripe dispute capture failed', err)
      return NextResponse.json({ error: 'Stripe capture failed' }, { status: 502 })
    }
    const { data, error } = await db.rpc('finalize_funded_task', {
      p_task_id: params.taskId, p_transaction_id: tx.id,
      p_reason: 'admin_dispute_pay_agent',
    })
    const result = Array.isArray(data) ? data[0] : data
    if (error || !result || result.task_status !== 'completed' || result.transaction_status !== 'released') {
      return NextResponse.json({ error: 'Stripe payment succeeded but database finalization must be retried' }, { status: 500 })
    }
  }

  return NextResponse.json({
    task_id: params.taskId,
    resolution,
    status: resolution === 'refund_buyer' ? 'cancelled' : 'completed',
  })
}
