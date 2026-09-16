import type Stripe from 'stripe'
import { auditLog } from '@/lib/server/audit'
import { getSupabase } from '@/lib/server/supabase'

export type PaymentState = 'pending' | 'processing' | 'authorized' | 'failed'

const HOURS_TO_MS = 60 * 60 * 1000

/**
 * Best-effort identity binding: records the transaction's stable
 * stripe_charge_id (free — already on the PaymentIntent's own
 * latest_charge field, no extra Stripe call) and, when a `stripe` client
 * is available, its stripe_transfer_id (one extra charges.retrieve,
 * since the Transfer id lives on the Charge, not the PaymentIntent).
 * Neither is required for the escrow state machine — this exists so a
 * later charge.dispute.* event (which carries charge/payment_intent ids,
 * never a task or transaction id) can be matched back to the right
 * transaction, and so an admin can jump straight to the right Stripe
 * Dashboard objects. Never throws: a failure here must never break
 * escrow reconciliation, which is why it's called after the transaction
 * is already confirmed 'held', not before.
 */
async function captureChargeIdentity(
  db: ReturnType<typeof getSupabase>,
  txId: string,
  intent: Stripe.PaymentIntent,
  stripe?: Stripe,
): Promise<void> {
  const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : (intent.latest_charge as Stripe.Charge | null)?.id ?? null
  if (!chargeId) return
  try {
    const { data: current, error: readError } = await db
      .from('transactions')
      .select('stripe_charge_id, stripe_transfer_id')
      .eq('id', txId)
      .maybeSingle()
    if (readError) throw readError
    if (current?.stripe_charge_id === chargeId && current?.stripe_transfer_id) return // already fully captured

    let transferId: string | null = current?.stripe_transfer_id ?? null
    if (!transferId && stripe) {
      const charge = await stripe.charges.retrieve(chargeId)
      transferId = typeof charge.transfer === 'string' ? charge.transfer : (charge.transfer as Stripe.Transfer | null)?.id ?? null
    }

    const { error: updateError } = await db
      .from('transactions')
      .update({ stripe_charge_id: chargeId, ...(transferId ? { stripe_transfer_id: transferId } : {}) })
      .eq('id', txId)
    if (updateError) throw updateError
  } catch (err) {
    console.error(`Could not capture charge/transfer identity for transaction ${txId}`, err)
  }
}

async function ensureFundedTaskStarted(
  db: ReturnType<typeof getSupabase>,
  tx: { id: string; task_id: string; agent_id: string; buyer_org_id: string },
  intent: Stripe.PaymentIntent,
  eventType?: string,
): Promise<void> {
  const { data: task, error: taskError } = await db
    .from('tasks')
    .select('id,status,delivery_deadline_at,assigned_agent_id,posted_by_org_id,archived_at,moderation_status,organizations!posted_by_org_id(is_platform_seed)')
    .eq('id', tx.task_id)
    .maybeSingle()
  if (taskError) throw taskError
  if (!task) throw new Error('Funded transaction has no task')
  if (task.archived_at || task.moderation_status !== 'approved' || (task.organizations as any)?.is_platform_seed === true) {
    throw new Error('Funded transaction belongs to an unavailable task')
  }
  if (task.assigned_agent_id !== tx.agent_id || task.posted_by_org_id !== tx.buyer_org_id) {
    throw new Error('Funded transaction does not match task assignment')
  }

  // A later workflow state proves the assigned -> in_progress transition
  // already happened. An exact in_progress state is likewise idempotent.
  if (['in_progress', 'review', 'completed'].includes(task.status)) return
  if (task.status !== 'assigned') {
    throw new Error(`Funded task cannot start from status ${task.status}`)
  }

  const { data: acceptedBid, error: bidError } = await db
    .from('bids')
    .select('id,delivery_hours')
    .eq('task_id', tx.task_id)
    .eq('status', 'accepted')
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (bidError) throw bidError

  const deliveryHours = Number(acceptedBid?.delivery_hours)
  if (!acceptedBid || !Number.isFinite(deliveryHours) || deliveryHours <= 0 || deliveryHours > 8760) {
    throw new Error('Funded task has no valid accepted-bid delivery SLA')
  }

  const deadline = new Date(Date.now() + deliveryHours * HOURS_TO_MS).toISOString()
  const { data: transitioned, error: transitionError } = await db
    .from('tasks')
    .update({ status: 'in_progress', delivery_deadline_at: deadline })
    .eq('id', tx.task_id)
    .eq('status', 'assigned')
    .select('id')
    .maybeSingle()
  if (transitionError) throw transitionError

  if (!transitioned) {
    // Another webhook/status-check may have won the same conditional
    // transition. Verify that it really reached an allowed later state;
    // never acknowledge Stripe based on an assumption.
    const { data: currentTask, error: rereadError } = await db
      .from('tasks')
      .select('status')
      .eq('id', tx.task_id)
      .maybeSingle()
    if (rereadError) throw rereadError
    if (!currentTask || !['in_progress', 'review', 'completed'].includes(currentTask.status)) {
      throw new Error('Funded task transition was not confirmed')
    }
    return
  }

  await auditLog({
    action: 'payment_funded',
    resource_type: 'transaction',
    resource_id: tx.id,
    details: { task_id: tx.task_id, stripe_id: intent.id, stripe_status: intent.status, event_type: eventType },
  })
}

/**
 * Reconcile Stripe's source-of-truth status into Mercatai's transaction and
 * task state. The update is idempotent so both the browser status check and a
 * Stripe webhook can safely call it.
 */
export async function reconcilePaymentIntent(
  intent: Stripe.PaymentIntent,
  eventType?: string,
  stripe?: Stripe,
): Promise<PaymentState> {
  const db = getSupabase()
  const { data: tx, error: txReadError } = await db
    .from('transactions')
    .select('id, task_id, agent_id, buyer_org_id, escrow_status')
    .eq('stripe_payment_intent_id', intent.id)
    .maybeSingle()
  if (txReadError) throw txReadError

  if (!tx) return stripeState(intent)

  const funded = intent.status === 'requires_capture' || intent.status === 'succeeded'
  if (funded && (tx.escrow_status === 'pending' || tx.escrow_status === 'held')) {
    if (tx.escrow_status === 'pending') {
      const { data: updated, error: txUpdateError } = await db
        .from('transactions')
        .update({ escrow_status: 'held' })
        .eq('id', tx.id)
        .eq('escrow_status', 'pending')
        .select('id')
        .maybeSingle()
      if (txUpdateError) throw txUpdateError

      if (!updated) {
        const { data: currentTx, error: rereadError } = await db
          .from('transactions')
          .select('escrow_status')
          .eq('id', tx.id)
          .maybeSingle()
        if (rereadError) throw rereadError
        if (currentTx?.escrow_status !== 'held') {
          throw new Error('Funded transaction transition was not confirmed')
        }
      }
    }

    // Deliberately runs for BOTH newly-held and already-held transactions.
    // If a previous attempt updated the transaction but failed to start the
    // task, the next webhook or status reconciliation repairs it.
    await ensureFundedTaskStarted(db, tx, intent, eventType)
    // Best-effort — see captureChargeIdentity's own doc comment for why a
    // failure here never throws or blocks the state machine above.
    await captureChargeIdentity(db, tx.id, intent, stripe)
  }

  // eventType alone is not a source of truth: Stripe can deliver an old
  // payment_failed event after a later success. The webhook route retrieves
  // the current PaymentIntent before calling us, so only its current state
  // decides whether execution must be stopped.
  const failed = intent.status === 'canceled'
    || (eventType === 'payment_intent.payment_failed' && !funded && intent.status !== 'processing')
  if (failed && (tx.escrow_status === 'pending' || tx.escrow_status === 'held')) {
    const { data: invalidated, error: invalidationError } = await db.rpc('invalidate_task_funding', {
      p_transaction_id: tx.id,
      p_task_id: tx.task_id,
    })
    if (invalidationError) throw invalidationError
    const invalidation = Array.isArray(invalidated) ? invalidated[0] : invalidated
    if (invalidation?.transaction_status !== 'failed') {
      throw new Error('Failed payment invalidation was not confirmed')
    }
    await auditLog({
      action: 'payment_failed',
      resource_type: 'transaction',
      resource_id: tx.id,
      details: { task_id: tx.task_id, stripe_id: intent.id, stripe_status: intent.status, event_type: eventType },
    })
  }

  return stripeState(intent)
}

function stripeState(intent: Stripe.PaymentIntent): PaymentState {
  if (intent.status === 'requires_capture' || intent.status === 'succeeded') return 'authorized'
  if (intent.status === 'processing') return 'processing'
  if (intent.status === 'canceled') return 'failed'
  return 'pending'
}
