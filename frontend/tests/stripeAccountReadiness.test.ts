import { describe, expect, it } from 'vitest'
import {
  computeStripeAccountReadiness,
  isMethodReady,
  classifyDisabledReason,
  disabledReasonBlockingResponse,
} from '@/lib/server/stripeAccountReadiness'

function account(overrides: Record<string, unknown> = {}) {
  return {
    details_submitted: true,
    requirements: { currently_due: [] },
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    ...overrides,
  } as any
}

describe('computeStripeAccountReadiness', () => {
  it('is fully ready when identity is verified, transfers/payouts are active, and both payment methods are active', () => {
    const readiness = computeStripeAccountReadiness(account())
    expect(readiness.identityVerified).toBe(true)
    expect(readiness.payoutReady).toBe(true)
    expect(readiness.cardReady).toBe(true)
    expect(readiness.sepaDebitReady).toBe(true)
    expect(readiness.onboardingComplete).toBe(true)
  })

  it('is not complete when details_submitted is false, even with active capabilities', () => {
    const readiness = computeStripeAccountReadiness(account({ details_submitted: false }))
    expect(readiness.identityVerified).toBe(false)
    expect(readiness.onboardingComplete).toBe(false)
  })

  it('is not complete when there are still currently_due requirements', () => {
    const readiness = computeStripeAccountReadiness(account({ requirements: { currently_due: ['individual.id_number'] } }))
    expect(readiness.identityVerified).toBe(false)
    expect(readiness.onboardingComplete).toBe(false)
  })

  it('is not complete when transfers capability is not active, even if details_submitted and currently_due are clean', () => {
    const readiness = computeStripeAccountReadiness(
      account({ capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'pending' } })
    )
    expect(readiness.transfersStatus).toBe('pending')
    expect(readiness.payoutReady).toBe(false)
    expect(readiness.onboardingComplete).toBe(false)
  })

  it('is not complete when payouts_enabled is false, even with transfers active', () => {
    const readiness = computeStripeAccountReadiness(account({ payouts_enabled: false }))
    expect(readiness.payoutReady).toBe(false)
    expect(readiness.onboardingComplete).toBe(false)
  })

  it('is complete with only SEPA active, no card capability at all', () => {
    const readiness = computeStripeAccountReadiness(
      account({ capabilities: { sepa_debit_payments: 'active', transfers: 'active' } })
    )
    expect(readiness.cardReady).toBe(false)
    expect(readiness.sepaDebitReady).toBe(true)
    expect(readiness.onboardingComplete).toBe(true)
  })

  it('treats a missing capability as inactive, not as active or as an error', () => {
    const readiness = computeStripeAccountReadiness(account({ capabilities: {} }))
    expect(readiness.cardPaymentsStatus).toBe('inactive')
    expect(readiness.sepaDebitPaymentsStatus).toBe('inactive')
    expect(readiness.transfersStatus).toBe('inactive')
    expect(readiness.onboardingComplete).toBe(false)
  })

  it('is not complete when neither card nor SEPA is active, even with transfers/payouts ready', () => {
    const readiness = computeStripeAccountReadiness(
      account({ capabilities: { card_payments: 'inactive', sepa_debit_payments: 'inactive', transfers: 'active' } })
    )
    expect(readiness.payoutReady).toBe(true)
    expect(readiness.onboardingComplete).toBe(false)
  })

  it('marks neither method ready when charges_enabled is false, even with both capabilities active', () => {
    const readiness = computeStripeAccountReadiness(account({ charges_enabled: false }))
    expect(readiness.cardReady).toBe(false)
    expect(readiness.sepaDebitReady).toBe(false)
    expect(readiness.onboardingComplete).toBe(false)
  })
})

describe('isMethodReady', () => {
  it('requires payoutReady plus cardReady for card', () => {
    const readiness = computeStripeAccountReadiness(
      account({ capabilities: { card_payments: 'inactive', sepa_debit_payments: 'active', transfers: 'active' } })
    )
    expect(isMethodReady(readiness, 'card')).toBe(false)
    expect(isMethodReady(readiness, 'sepa_debit')).toBe(true)
  })

  it('requires payoutReady plus sepaDebitReady for sepa_debit', () => {
    const readiness = computeStripeAccountReadiness(
      account({ capabilities: { card_payments: 'active', sepa_debit_payments: 'inactive', transfers: 'active' } })
    )
    expect(isMethodReady(readiness, 'sepa_debit')).toBe(false)
    expect(isMethodReady(readiness, 'card')).toBe(true)
  })

  it('rejects both methods when payoutReady is false, even if the method-specific capability is active', () => {
    const readiness = computeStripeAccountReadiness(account({ payouts_enabled: false }))
    expect(isMethodReady(readiness, 'card')).toBe(false)
    expect(isMethodReady(readiness, 'sepa_debit')).toBe(false)
  })
})

describe('classifyDisabledReason', () => {
  it('treats null, undefined, and empty string as the normal (no restriction) case', () => {
    expect(classifyDisabledReason(null).action).toBe('proceed')
    expect(classifyDisabledReason(undefined).action).toBe('proceed')
    expect(classifyDisabledReason('').action).toBe('proceed')
  })

  it('requirements.past_due is remediable via a fresh onboarding link — proceed, not blocked', () => {
    const result = classifyDisabledReason('requirements.past_due')
    expect(result.action).toBe('proceed')
    expect(result.disabledReason).toBe('requirements.past_due')
  })

  it('action_required.requested_capabilities means Mercatai must request capabilities first, then proceed', () => {
    const result = classifyDisabledReason('action_required.requested_capabilities')
    expect(result.action).toBe('request_capabilities_then_proceed')
  })

  it.each(['requirements.pending_verification', 'under_review'])(
    '%s means waiting for Stripe, not a new link',
    (reason) => {
      const result = classifyDisabledReason(reason)
      expect(result.action).toBe('wait_for_stripe')
      expect(result.disabledReason).toBe(reason)
    }
  )

  it.each([
    'listed',
    'rejected.fraud',
    'rejected.incomplete_verification',
    'rejected.listed',
    'rejected.other',
    'rejected.terms_of_service',
    'platform_paused',
    'other',
  ])('%s is genuinely blocked — manual Stripe Dashboard review', (reason) => {
    const result = classifyDisabledReason(reason)
    expect(result.action).toBe('manual_stripe_dashboard_review')
    expect(result.disabledReason).toBe(reason)
  })

  it('an unrecognized future value fails toward manual review rather than silently proceeding', () => {
    const result = classifyDisabledReason('something_stripe_adds_next_year')
    expect(result.action).toBe('manual_stripe_dashboard_review')
  })
})

describe('disabledReasonBlockingResponse', () => {
  it('returns null (proceed) for the proceed and request_capabilities_then_proceed classifications', () => {
    expect(disabledReasonBlockingResponse(classifyDisabledReason(null), 'acct_1')).toBeNull()
    expect(disabledReasonBlockingResponse(classifyDisabledReason('requirements.past_due'), 'acct_1')).toBeNull()
    expect(disabledReasonBlockingResponse(classifyDisabledReason('action_required.requested_capabilities'), 'acct_1')).toBeNull()
  })

  it('returns a 409 with action_required: wait_for_stripe for a Stripe-side-pending reason, without claiming the user must act', () => {
    const response = disabledReasonBlockingResponse(classifyDisabledReason('under_review'), 'acct_1')
    expect(response?.status).toBe(409)
    expect(response?.body.action_required).toBe('wait_for_stripe')
    expect(response?.body.stripe_account_id).toBe('acct_1')
    expect(String(response?.body.error)).not.toMatch(/contact support|must (provide|supply|submit)/i)
  })

  it('returns a 409 with action_required: manual_stripe_dashboard_review for a blocked reason', () => {
    const response = disabledReasonBlockingResponse(classifyDisabledReason('rejected.fraud'), 'acct_1')
    expect(response?.status).toBe(409)
    expect(response?.body.action_required).toBe('manual_stripe_dashboard_review')
    expect(response?.body.disabled_reason).toBe('rejected.fraud')
  })
})
