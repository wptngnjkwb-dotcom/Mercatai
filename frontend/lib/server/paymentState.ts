import type Stripe from 'stripe'
import { auditLog } from '@/lib/server/audit'
import { getSupabase } from '@/lib/server/supabase'
import { paymentContextFromTransaction, stripeRequestOptions, type StripePaymentContext } from '@/lib/server/stripePaymentContext'

export type PaymentState = 'pending' | 'processing' | 'authorized' | 'failed'

const HOURS_TO_MS = 60 * 60 * 1000

export interface PaymentIdentityOutcome {
  stripeChargeId: string | null
  stripeTransferId: string | null
}

/**
 * Idempotently records a transaction's stripe_charge_id/stripe_transfer_id
 * from Stripe's own CURRENT PaymentIntent/Charge — via
 * record_payment_charge_identity (frontend/sql/20_payment_charge_transfer_identity.sql),
 * which works at ANY escrow_status, including 'released'. A live sandbox
 * run found two real gaps in the previous best-effort version: a
 * a legacy destination charge's Transfer isn't always attached to the
 * Charge the instant it's captured, and every path that finalizes a funded
 * transaction flips escrow_status straight to 'released' in the same
 * request as the capture — permanently excluding a transaction from the
 * old pending/held-only gate the moment a Transfer became visible a
 * moment too late.
 *
 * Write rules (enforced in SQL, not here): a NULL stored id can be filled
 * in; an identical id is an idempotent no-op success; an EXISTING id that
 * differs from what Stripe now reports is NEVER overwritten — logged to
 * audit_logs atomically instead, and surfaced by throwing here so a
 * caller (the webhook route in particular) never silently accepts a
 * mismatch. Unlike the old helper, this DOES throw on failure — capture,
 * escrow release, task state, reputation and free-task accounting are
 * all handled elsewhere and never re-run by a retry of this call, so
 * letting a caller's retry logic see the failure is always safe.
 */
export async function recordPaymentChargeIdentity(
  db: ReturnType<typeof getSupabase>,
  txId: string,
  intent: Stripe.PaymentIntent,
  stripe?: Stripe,
  context: StripePaymentContext = { chargeModel: 'destination', connectedAccountId: null },
): Promise<PaymentIdentityOutcome | null> {
  const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : (intent.latest_charge as Stripe.Charge | null)?.id ?? null
  if (!chargeId) {
    // A 'succeeded' PaymentIntent always has a Charge — Stripe creates it
    // as part of the capture itself, no propagation delay possible. Seeing
    // none here means the caller passed a stale/incomplete snapshot; treat
    // it as a failure to record so the caller retries with fresher data,
    // rather than quietly recording nothing for a payment that DID settle.
    if (intent.status === 'succeeded') {
      throw new Error(`Payment intent ${intent.id} succeeded but has no latest_charge yet — retry required`)
    }
    return null
  }

  let transferId: string | null = null
  if (stripe) {
    const charge = await stripe.charges.retrieve(chargeId, stripeRequestOptions(context))
    transferId = typeof charge.transfer === 'string' ? charge.transfer : (charge.transfer as Stripe.Transfer | null)?.id ?? null
  }

  const { data, error } = context.chargeModel === 'direct'
    ? await db.rpc('record_payment_charge_identity_v2', {
      p_transaction_id: txId,
      p_stripe_payment_intent_id: intent.id,
      p_stripe_charge_id: chargeId,
      p_stripe_transfer_id: transferId,
      p_charge_model: context.chargeModel,
      p_stripe_connected_account_id: context.connectedAccountId,
    })
    : await db.rpc('record_payment_charge_identity', {
      p_transaction_id: txId,
      p_stripe_payment_intent_id: intent.id,
      p_stripe_charge_id: chargeId,
      p_stripe_transfer_id: transferId,
    })
  if (error) throw new Error(`Failed to record payment charge/transfer identity for transaction ${txId}: ${error.message}`)
  const result = Array.isArray(data) ? data[0] : data
  if (!result) throw new Error(`Failed to record payment charge/transfer identity for transaction ${txId}: RPC returned no row`)

  if (result.charge_id_conflict || result.transfer_id_conflict) {
    throw new Error(
      `Stripe charge/transfer identity mismatch for transaction ${txId} — an existing id differs from Stripe's current data and was not overwritten (see audit_logs: payment_identity_mismatch)`
    )
  }

  // For a genuinely SETTLED legacy payment ('succeeded'), a destination charge's
  // Transfer can lag its Charge by a brief moment (the exact gap a live
  // sandbox run found) — but it always arrives. Rather than silently
  // persisting a charge-only identity and hoping something calls this
  // again later, treat a still-missing transfer as a failure here so the
  // caller retries (the webhook route's existing try/catch returns 500,
  // Stripe redelivers; the capture routes surface their own retryable
  // error) — the charge_id write above already committed either way, so
  // the retry only has the transfer left to fill in.
  // Direct Charges have no Transfer object at all: the Charge already lives
  // on the connected account. 'requires_capture' (authorized but not yet
  // captured) deliberately
  // stays exempt: a destination charge's Transfer never exists before an
  // actual capture, so a missing transfer there is normal, not a gap.
  if (context.chargeModel === 'destination' && intent.status === 'succeeded' && !result.stripe_transfer_id) {
    throw new Error(`Payment intent ${intent.id} succeeded but its Transfer is not yet attached to charge ${result.stripe_charge_id} — retry required`)
  }

  return { stripeChargeId: result.stripe_charge_id, stripeTransferId: result.stripe_transfer_id }
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
  expectedContext?: StripePaymentContext,
): Promise<PaymentState> {
  const db = getSupabase()
  const { data: tx, error: txReadError } = await db
    .from('transactions')
    .select('id, task_id, agent_id, buyer_org_id, escrow_status, stripe_charge_model, stripe_connected_account_id')
    .eq('stripe_payment_intent_id', intent.id)
    .maybeSingle()
  if (txReadError) throw txReadError

  if (!tx) return stripeState(intent)

  const paymentContext = paymentContextFromTransaction(tx)
  if (expectedContext && (
    expectedContext.chargeModel !== paymentContext.chargeModel
    || expectedContext.connectedAccountId !== paymentContext.connectedAccountId
  )) {
    throw new Error('Stripe webhook/payment context does not match the transaction')
  }

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
  }

  // Identity backfill is deliberately OUTSIDE the pending/held branch
  // above and gated only on `funded` — it must keep working after the
  // transaction reaches 'released' (see recordPaymentChargeIdentity's own
  // doc comment), so a late payment_intent.succeeded webhook or a plain
  // status check can still backfill a transfer id a synchronous capture
  // path didn't have yet. `funded` itself already excludes a failed or
  // refunded-looking PaymentIntent (status outside requires_capture/
  // succeeded), so a declined attempt's stale charge is never recorded as
  // if it belonged to a genuinely funded transaction. Unlike the escrow
  // transition above, a failure here is never swallowed — it must
  // propagate so the webhook route returns 500 and Stripe retries.
  if (funded) {
    await recordPaymentChargeIdentity(db, tx.id, intent, stripe, paymentContext)
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
