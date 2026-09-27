import type Stripe from 'stripe'
import { paymentContextFromTransaction, stripeRequestOptions } from '@/lib/server/stripePaymentContext'

export type CancelOrRefundResult =
  | { outcome: 'refunded' }
  | { outcome: 'canceled' }
  | { outcome: 'already_canceled' }
  | { outcome: 'not_possible'; stripeStatus: string }

type TransactionForRefund = {
  id: string
  stripe_payment_intent_id: string | null
  stripe_charge_model?: string | null
  stripe_connected_account_id?: string | null
}

/**
 * The one place that cancels an uncaptured card hold or refunds an
 * already-settled charge. SEPA Direct Debit has no manual capture, so by
 * the time a SEPA-funded transaction is `held` it has already settled —
 * only a real refund can reverse it; cancelling a succeeded intent would
 * error. Shared by every path that ever gives money back: the buyer/admin
 * refund endpoint, the SLA-missed cron, and an agent's voluntary
 * quality-issue refund — written once so a future change to this rule
 * never has to be made in more than one place.
 */
export async function cancelOrRefundHeldPayment(
  stripe: Stripe,
  tx: TransactionForRefund,
  idempotencyKey: string,
): Promise<CancelOrRefundResult> {
  const context = paymentContextFromTransaction(tx)
  const requestOptions = stripeRequestOptions(context)
  const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id!, requestOptions)
  if (intent.status === 'succeeded') {
    await stripe.refunds.create({
      payment_intent: tx.stripe_payment_intent_id!,
      refund_application_fee: true,
      ...(context.chargeModel === 'destination' ? { reverse_transfer: true } : {}),
    }, stripeRequestOptions(context, idempotencyKey))
    return { outcome: 'refunded' }
  }
  if (intent.status === 'requires_capture') {
    await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id!, {}, requestOptions)
    return { outcome: 'canceled' }
  }
  if (intent.status === 'canceled') {
    // A previous attempt may have canceled/refunded Stripe successfully
    // and then lost the DB response — the caller continues to its own
    // idempotent finalization RPC rather than erroring here.
    return { outcome: 'already_canceled' }
  }
  return { outcome: 'not_possible', stripeStatus: intent.status }
}
