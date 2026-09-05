import { describe, expect, it } from 'vitest'
import { calculateFees } from '@/lib/server/fees'
import { DEFAULT_PLATFORM_FEE_PERCENT } from '@/lib/server/settings'

describe('calculateFees — payment-processing deduction (0.8%, capped at €5)', () => {
  it('deducts 0.8% of the gross amount when under the €5 cap', () => {
    const fees = calculateFees(100, 0)
    expect(fees.stripe_fee_eur).toBe(0.8)
  })

  it('caps the deduction at €5 once 0.8% of gross would exceed it', () => {
    expect(calculateFees(625, 0).stripe_fee_eur).toBe(5) // exactly at the cap boundary
    expect(calculateFees(1000, 0).stripe_fee_eur).toBe(5)
    expect(calculateFees(1_000_000, 0).stripe_fee_eur).toBe(5)
  })

  it('rounds every component to the nearest cent', () => {
    // 33.33 * 0.008 = 0.26664 -> must round to 0.27, not truncate to 0.26
    const fees = calculateFees(33.33, DEFAULT_PLATFORM_FEE_PERCENT)
    expect(fees.stripe_fee_eur).toBeCloseTo(0.27, 2)
    for (const value of [fees.stripe_fee_eur, fees.platform_fee_eur, fees.agent_payout_eur]) {
      expect(Number.isInteger(Math.round(value * 100))).toBe(true)
    }
  })

  it('the three components sum back to the gross amount within rounding tolerance', () => {
    for (const gross of [1, 33.33, 100, 625, 1000, 9999.99]) {
      const fees = calculateFees(gross, DEFAULT_PLATFORM_FEE_PERCENT)
      const sum = fees.stripe_fee_eur + fees.platform_fee_eur + fees.agent_payout_eur
      expect(Math.abs(sum - gross)).toBeLessThanOrEqual(0.02)
    }
  })
})

describe("an agent's first 10 paid tasks — 0% marketplace fee, deduction still applies", () => {
  // Mirrors create-intent/route.ts's free-task override exactly:
  //   fees.platform_fee_eur = 0
  //   fees.agent_payout_eur = Math.round((gross_amount_eur - fees.stripe_fee_eur) * 100) / 100
  function applyFreeTaskOverride(gross: number) {
    const fees = calculateFees(gross)
    const stripe_fee_eur = fees.stripe_fee_eur
    const platform_fee_eur = 0
    const agent_payout_eur = Math.round((gross - stripe_fee_eur) * 100) / 100
    return { stripe_fee_eur, platform_fee_eur, agent_payout_eur }
  }

  it('pays out €99.20 on a €100 task — only the 0.8% deduction applies', () => {
    const fees = applyFreeTaskOverride(100)
    expect(fees.stripe_fee_eur).toBe(0.8)
    expect(fees.platform_fee_eur).toBe(0)
    expect(fees.agent_payout_eur).toBe(99.2)
  })

  it('pays out €995.00 on a €1,000 task — the deduction is capped at €5', () => {
    const fees = applyFreeTaskOverride(1000)
    expect(fees.stripe_fee_eur).toBe(5)
    expect(fees.platform_fee_eur).toBe(0)
    expect(fees.agent_payout_eur).toBe(995)
  })
})

describe("after an agent's first 10 paid tasks — the current marketplace fee also applies", () => {
  it('deducts the processing fee and the default 4.2% marketplace fee on a €100 task', () => {
    const fees = calculateFees(100, DEFAULT_PLATFORM_FEE_PERCENT)
    expect(fees.stripe_fee_eur).toBe(0.8)
    expect(fees.platform_fee_eur).toBe(4.2)
    expect(fees.agent_payout_eur).toBe(95)
  })

  it('deducts the capped €5 processing fee and the default 4.2% marketplace fee on a €1,000 task', () => {
    const fees = calculateFees(1000, DEFAULT_PLATFORM_FEE_PERCENT)
    expect(fees.stripe_fee_eur).toBe(5)
    expect(fees.platform_fee_eur).toBe(42)
    expect(fees.agent_payout_eur).toBe(953)
  })
})
