import { describe, expect, it } from 'vitest'
import { calculateFees } from '@/lib/server/fees'
import { DEFAULT_PLATFORM_FEE_PERCENT } from '@/lib/server/settings'

// The first paid pilot tasks are €3. create-intent freezes these numbers and
// hands Stripe `amount` and `application_fee_amount` in integer cents, so on
// small amounts any rounding drift would be a real cent lost or invented.
// create-intent zeroes the platform fee for an agent's free tasks and
// recomputes the payout, so both variants are covered here.
const cents = (eur: number) => Math.round(eur * 100)

function terms(grossCents: number, free: boolean) {
  const gross = grossCents / 100
  const fees = calculateFees(gross, DEFAULT_PLATFORM_FEE_PERCENT)
  if (free) {
    fees.platform_fee_eur = 0
    fees.agent_payout_eur = Math.round((gross - fees.stripe_fee_eur) * 100) / 100
  }
  return {
    gross,
    ...fees,
    amountCents: cents(gross),
    applicationFeeCents: cents(fees.platform_fee_eur + fees.stripe_fee_eur),
  }
}

describe('€3 pilot task — exact money terms', () => {
  it('free task (first 10): €0.02 Mercatai deduction, no marketplace fee, €2.98 after Mercatai fees', () => {
    const t = terms(300, true)
    expect(t.stripe_fee_eur).toBe(0.02)
    expect(t.platform_fee_eur).toBe(0)
    expect(t.agent_payout_eur).toBe(2.98)
    expect(t.amountCents).toBe(300)
    expect(t.applicationFeeCents).toBe(2)
  })

  it('task after the free window: €0.02 + €0.13 (4.2%), €2.85 after Mercatai fees', () => {
    const t = terms(300, false)
    expect(t.stripe_fee_eur).toBe(0.02)
    expect(t.platform_fee_eur).toBe(0.13)
    expect(t.agent_payout_eur).toBe(2.85)
    expect(t.applicationFeeCents).toBe(15)
  })
})

describe('every price from €1.00 to €10.00 — cents stay exact', () => {
  for (const free of [true, false]) {
    it(`${free ? 'free' : 'paid'} task: components sum to gross, fee is whole cents, payout is never negative`, () => {
      for (let grossCents = 100; grossCents <= 1000; grossCents++) {
        const t = terms(grossCents, free)
        const label = `gross=${grossCents}c free=${free}`
        const componentCents = cents(t.stripe_fee_eur) + cents(t.platform_fee_eur) + cents(t.agent_payout_eur)
        expect(componentCents, `${label}: components must add up to the charged amount`).toBe(t.amountCents)
        expect(Number.isInteger(t.applicationFeeCents), label).toBe(true)
        expect(t.applicationFeeCents, `${label}: fee cannot exceed the charge`).toBeLessThanOrEqual(t.amountCents)
        expect(t.agent_payout_eur, `${label}: payout must not be negative`).toBeGreaterThanOrEqual(0)
      }
    })
  }
})
