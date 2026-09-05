import type Stripe from 'stripe'
import { auditLog } from '@/lib/server/audit'
import type { getSupabase } from '@/lib/server/supabase'

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

  // A capability can show 'active' while the account is still, in practice,
  // unable to actually charge anyone — charges_enabled is Stripe's own
  // umbrella flag for that, so it gates both methods regardless of their
  // individual capability status.
  const chargesEnabled = !!account.charges_enabled
  const cardReady = cardPaymentsStatus === 'active' && chargesEnabled
  const sepaDebitReady = sepaDebitPaymentsStatus === 'active' && chargesEnabled
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

/**
 * Keeps agents.stripe_onboarding_completed in sync with what was just
 * computed from live Stripe data — in both directions. A no-op when the two
 * already agree, so every caller that has just computed readiness can call
 * this unconditionally rather than duplicating the "did it change" check
 * and the matching audit-log call. Both the onboarding-status GET route and
 * create-intent (which fetches live account data anyway, to gate the
 * PaymentIntent it's about to create) call this, so a stale `true` left
 * over from before Stripe restricted a capability gets corrected by
 * whichever of the two happens to run next — including a buyer's own
 * payment attempt.
 */
export async function syncOnboardingCompletedFlag(
  db: ReturnType<typeof getSupabase>,
  agentDbId: string | undefined | null,
  storedValue: boolean | undefined | null,
  computedValue: boolean
): Promise<void> {
  if (!agentDbId || computedValue === !!storedValue) return
  const { error } = await db.from('agents').update({ stripe_onboarding_completed: computedValue }).eq('id', agentDbId)
  if (error) {
    // Fail closed: never write an audit log claiming this changed when the
    // write didn't actually happen — a caller, or a human reading the audit
    // log later, must not be able to trust a completion/restriction record
    // that isn't backed by the database actually reflecting it.
    throw new Error(`Failed to sync stripe_onboarding_completed for agent ${agentDbId}: ${error.message}`)
  }
  await auditLog({
    action: computedValue ? 'stripe_connect_onboard_completed' : 'stripe_connect_onboard_restricted',
    resource_type: 'agent',
    resource_id: agentDbId,
    details: { stripe_onboarding_completed: computedValue },
  })
}
