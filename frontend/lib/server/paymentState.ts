import type Stripe from 'stripe'
import { auditLog } from '@/lib/server/audit'
import { getSupabase } from '@/lib/server/supabase'

export type PaymentState = 'pending' | 'processing' | 'authorized' | 'failed'

/**
 * Reconcile Stripe's source-of-truth status into Mercatai's transaction and
 * task state. The update is idempotent so both the browser status check and a
 * Stripe webhook can safely call it.
 */
export async function reconcilePaymentIntent(
  intent: Stripe.PaymentIntent,
  eventType?: string,
): Promise<PaymentState> {
  const db = getSupabase()
  const { data: tx } = await db
    .from('transactions')
    .select('id, task_id, escrow_status')
    .eq('stripe_payment_intent_id', intent.id)
    .maybeSingle()

  if (!tx) return stripeState(intent)

  const funded = intent.status === 'requires_capture' || intent.status === 'succeeded'
  if (funded && tx.escrow_status === 'pending') {
    const { data: updated } = await db
      .from('transactions')
      .update({ escrow_status: 'held' })
      .eq('id', tx.id)
      .eq('escrow_status', 'pending')
      .select('id')
      .maybeSingle()

    if (updated) {
      await db.from('tasks').update({ status: 'in_progress' }).eq('id', tx.task_id).eq('status', 'assigned')
      await auditLog({
        action: 'payment_funded',
        resource_type: 'transaction',
        resource_id: tx.id,
        details: { task_id: tx.task_id, stripe_id: intent.id, stripe_status: intent.status, event_type: eventType },
      })
    }
  }

  const failed = intent.status === 'canceled' || eventType === 'payment_intent.payment_failed'
  if (failed && tx.escrow_status === 'pending') {
    const { data: updated } = await db
      .from('transactions')
      .update({ escrow_status: 'failed' })
      .eq('id', tx.id)
      .eq('escrow_status', 'pending')
      .select('id')
      .maybeSingle()

    if (updated) {
      await auditLog({
        action: 'payment_failed',
        resource_type: 'transaction',
        resource_id: tx.id,
        details: { task_id: tx.task_id, stripe_id: intent.id, stripe_status: intent.status, event_type: eventType },
      })
    }
  }

  return stripeState(intent)
}

function stripeState(intent: Stripe.PaymentIntent): PaymentState {
  if (intent.status === 'requires_capture' || intent.status === 'succeeded') return 'authorized'
  if (intent.status === 'processing') return 'processing'
  if (intent.status === 'canceled') return 'failed'
  return 'pending'
}
