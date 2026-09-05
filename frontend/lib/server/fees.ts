import { DEFAULT_PLATFORM_FEE_PERCENT } from './settings'

// Fee structure: a payment-processing deduction of 0.8% of the gross amount
// (capped at €5) + a platform fee (default 4.2%). The 0.8%/€5 figure is set
// by Mercatai and collected via Stripe's application_fee_amount on a
// destination charge — it is NOT an itemized Stripe invoice for that
// payment, and under the current model Mercatai (not the agent) bears
// Stripe's real processing cost. The `stripe_fee_eur` field name is kept
// for database/API backward compatibility; the public API additionally
// exposes this same value as `payment_processing_deduction_eur` (see
// create-intent/route.ts). The platform fee is configurable via admin
// settings (platform_fee_percent).
export function calculateFees(grossEur: number, platformFeePercent = DEFAULT_PLATFORM_FEE_PERCENT) {
  const paymentProcessingDeduction = Math.round(Math.min(grossEur * 0.008, 5.0) * 100) / 100
  const platformFeeRounded = Math.round(grossEur * (platformFeePercent / 100) * 100) / 100
  const agentPayout = Math.round((grossEur - paymentProcessingDeduction - platformFeeRounded) * 100) / 100

  return {
    stripe_fee_eur: paymentProcessingDeduction,
    platform_fee_eur: platformFeeRounded,
    agent_payout_eur: agentPayout,
  }
}
