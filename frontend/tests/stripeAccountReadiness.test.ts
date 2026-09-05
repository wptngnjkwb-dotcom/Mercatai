import { describe, expect, it } from 'vitest'
import { computeStripeAccountReadiness, isMethodReady } from '@/lib/server/stripeAccountReadiness'

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
