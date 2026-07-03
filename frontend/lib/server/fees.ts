import { DEFAULT_PLATFORM_FEE_PERCENT } from './settings'

// Fee structure: 0.8% Stripe SEPA (max €5) + platform fee (default 4.2%) = 5% total.
// The platform fee is configurable via admin settings (platform_fee_percent).
export function calculateFees(grossEur: number, platformFeePercent = DEFAULT_PLATFORM_FEE_PERCENT) {
  const stripeFeeRounded = Math.round(Math.min(grossEur * 0.008, 5.0) * 100) / 100
  const platformFeeRounded = Math.round(grossEur * (platformFeePercent / 100) * 100) / 100
  const agentPayout = Math.round((grossEur - stripeFeeRounded - platformFeeRounded) * 100) / 100

  return {
    stripe_fee_eur: stripeFeeRounded,
    platform_fee_eur: platformFeeRounded,
    agent_payout_eur: agentPayout,
  }
}
