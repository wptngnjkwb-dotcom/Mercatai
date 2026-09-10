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

export type DisabledReasonAction =
  | 'proceed'
  | 'request_capabilities_then_proceed'
  | 'wait_for_stripe'
  | 'manual_stripe_dashboard_review'

export interface DisabledReasonClassification {
  action: DisabledReasonAction
  disabledReason: string | null
}

// account.requirements.disabled_reason values meaning Stripe is actively
// working the account and nobody needs to act — see
// https://docs.stripe.com/connect/handling-api-verification#determine-if-verification-is-needed
const WAITING_FOR_STRIPE_REASONS = new Set(['requirements.pending_verification', 'under_review'])

/**
 * Classifies account.requirements.disabled_reason into what a caller should
 * actually do about it. Both stripe-onboard routes previously treated ANY
 * non-empty disabled_reason as a dead end requiring manual Stripe Dashboard
 * review — wrong for the two most common values in practice:
 *   - `requirements.past_due` just means the account needs to go through
 *     Stripe-hosted onboarding again to supply more information. That's the
 *     entire point of an onboarding/refresh link, not a reason to refuse one.
 *   - `action_required.requested_capabilities` means Mercatai itself hasn't
 *     requested a capability yet — an accounts.update() call fixes it, not
 *     a dashboard visit.
 * Getting this wrong meant an agent mid-onboarding could be told to
 * "contact support" for a completely normal, self-service state.
 *
 * Shared by both frontend/app/api/v1/agents/[id]/stripe-onboard/route.ts and
 * its refresh/route.ts sibling so they can never classify the same Stripe
 * state differently.
 */
export function classifyDisabledReason(disabledReason: string | null | undefined): DisabledReasonClassification {
  const reason = disabledReason || null
  if (!reason) return { action: 'proceed', disabledReason: null }
  if (reason === 'requirements.past_due') return { action: 'proceed', disabledReason: reason }
  if (reason === 'action_required.requested_capabilities') return { action: 'request_capabilities_then_proceed', disabledReason: reason }
  if (WAITING_FOR_STRIPE_REASONS.has(reason)) return { action: 'wait_for_stripe', disabledReason: reason }
  // listed, rejected.fraud, rejected.incomplete_verification, rejected.listed,
  // rejected.other, rejected.terms_of_service, platform_paused, other, and
  // any value Stripe adds later that this code doesn't yet recognize — fail
  // toward "needs a human," never toward silently proceeding.
  return { action: 'manual_stripe_dashboard_review', disabledReason: reason }
}

/**
 * Builds the blocking response for a classification that must not proceed
 * to a fresh Account Link — or null when the caller should continue
 * (possibly after first requesting missing capabilities; see
 * DisabledReasonAction). Shared so both stripe-onboard routes give an agent
 * the exact same status/action_required/message for the same underlying
 * Stripe state, instead of two hand-written copies that can drift apart.
 */
export function disabledReasonBlockingResponse(
  classification: DisabledReasonClassification,
  stripeAccountId: string
): { status: number; body: Record<string, unknown> } | null {
  if (classification.action === 'wait_for_stripe') {
    return {
      status: 409,
      body: {
        error: "Stripe is currently verifying this account's information — no action is needed right now. Check back shortly.",
        stripe_account_id: stripeAccountId,
        action_required: 'wait_for_stripe',
        disabled_reason: classification.disabledReason,
      },
    }
  }
  if (classification.action === 'manual_stripe_dashboard_review') {
    return {
      status: 409,
      body: {
        error: `This Stripe account needs manual review (Stripe's reason: ${classification.disabledReason}). Check the Stripe Dashboard or contact Stripe support directly — a new onboarding link cannot resolve this.`,
        stripe_account_id: stripeAccountId,
        action_required: 'manual_stripe_dashboard_review',
        disabled_reason: classification.disabledReason,
      },
    }
  }
  return null
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
