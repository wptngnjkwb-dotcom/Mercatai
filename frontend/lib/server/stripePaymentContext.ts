import type Stripe from 'stripe'
import type { getSupabase } from '@/lib/server/supabase'
import {
  type StripeAccountRequirement,
} from '@/lib/server/stripeAccountRequirement'

export type StripeChargeModel = 'destination' | 'direct'

export interface StripePaymentContext {
  chargeModel: StripeChargeModel
  connectedAccountId: string | null
}

type TransactionPaymentContext = {
  stripe_charge_model?: string | null
  stripe_connected_account_id?: string | null
}

export function paymentContextFromTransaction(tx: TransactionPaymentContext): StripePaymentContext {
  if (tx.stripe_charge_model !== null
      && tx.stripe_charge_model !== undefined
      && tx.stripe_charge_model !== 'destination'
      && tx.stripe_charge_model !== 'direct') {
    throw new Error('Transaction has an unknown Stripe charge model')
  }
  // NULL is intentionally treated as legacy destination context. Migration
  // 21 backfills every row that already has a PaymentIntent, but this fallback
  // also keeps a pre-migration in-flight row readable during a rolling deploy.
  const chargeModel: StripeChargeModel = tx.stripe_charge_model === 'direct' ? 'direct' : 'destination'
  const connectedAccountId = tx.stripe_connected_account_id ?? null
  if (chargeModel === 'direct' && !connectedAccountId?.startsWith('acct_')) {
    throw new Error('Direct-charge transaction has no valid connected-account context')
  }
  if (chargeModel === 'destination' && connectedAccountId !== null) {
    throw new Error('Destination-charge transaction has an unexpected connected-account context')
  }
  return { chargeModel, connectedAccountId }
}

export function stripeRequestOptions(
  context: StripePaymentContext,
  idempotencyKey?: string,
): Stripe.RequestOptions {
  return {
    ...(context.chargeModel === 'direct' && context.connectedAccountId
      ? { stripeAccount: context.connectedAccountId }
      : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }
}

export async function bindDirectChargeContext(
  db: ReturnType<typeof getSupabase>,
  transactionId: string,
  connectedAccountId: string,
  accountRequirement: StripeAccountRequirement,
): Promise<StripePaymentContext> {
  if (!connectedAccountId.startsWith('acct_')) throw new Error('Invalid connected Stripe account id')
  const { data, error } = await db.rpc('bind_payment_charge_context_v2', {
    p_transaction_id: transactionId,
    p_charge_model: 'direct',
    p_stripe_connected_account_id: connectedAccountId,
    p_stripe_account_requirement: accountRequirement,
  })
  if (error) throw new Error(`Failed to bind payment charge context: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row
      || row.stripe_charge_model !== 'direct'
      || row.stripe_connected_account_id !== connectedAccountId
      || row.stripe_account_requirement !== accountRequirement) {
    throw new Error('Payment charge context was not confirmed')
  }
  return { chargeModel: 'direct', connectedAccountId }
}

export function directChargeCreateOptions(connectedAccountId: string, idempotencyKey: string): Stripe.RequestOptions {
  return stripeRequestOptions({ chargeModel: 'direct', connectedAccountId }, idempotencyKey)
}
