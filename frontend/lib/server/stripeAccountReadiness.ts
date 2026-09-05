import type Stripe from 'stripe'

/**
 * Derives real payment readiness from a live Stripe Account object, rather
 * than the coarse `details_submitted && !currently_due.length` check this
 * replaced — that check ignores a capability being restricted, inactive,
 * or pending, and ignores whether payouts are actually enabled. Both the
 * onboarding-status route and create-intent (before creating a
 * PaymentIntent) must derive the same readiness from the same live Stripe
 * data, not from a stored database boolean, which can go stale the moment
 * Stripe restricts a previously-active capability.
 */
export interface StripeAccountReadiness {
  identityVerified: boolean
  cardPaymentsStatus: string
  sepaDebitPaymentsStatus: string
  transfersStatus: string
  cardReady: boolean
  sepaDebitReady: boolean
  payoutReady: boolean
  /** True only when identity is verified, payouts/transfers are active, and at least one payment method (card or SEPA) is active. */
  onboardingComplete: boolean
}

export function computeStripeAccountReadiness(account: Stripe.Account): StripeAccountReadiness {
  const capabilities = account.capabilities ?? {}
  const cardPaymentsStatus = capabilities.card_payments ?? 'inactive'
  const sepaDebitPaymentsStatus = capabilities.sepa_debit_payments ?? 'inactive'
  const transfersStatus = capabilities.transfers ?? 'inactive'

  const cardReady = cardPaymentsStatus === 'active'
  const sepaDebitReady = sepaDebitPaymentsStatus === 'active'
  const transfersReady = transfersStatus === 'active'
  const payoutReady = transfersReady && !!account.payouts_enabled

  const identityVerified = !!account.details_submitted && !(account.requirements?.currently_due?.length)

  const onboardingComplete = identityVerified && payoutReady && (cardReady || sepaDebitReady)

  return {
    identityVerified,
    cardPaymentsStatus,
    sepaDebitPaymentsStatus,
    transfersStatus,
    cardReady,
    sepaDebitReady,
    payoutReady,
    onboardingComplete,
  }
}

/** Which single readiness flag gates a given payment method's PaymentIntent creation. */
export function isMethodReady(readiness: StripeAccountReadiness, method: 'card' | 'sepa_debit'): boolean {
  return readiness.payoutReady && (method === 'card' ? readiness.cardReady : readiness.sepaDebitReady)
}
