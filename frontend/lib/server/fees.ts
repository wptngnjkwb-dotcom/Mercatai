// Fee structure: 0.8% Stripe SEPA (max €5) + 4.2% platform = 5% total, agent gets 95%
export function calculateFees(grossEur: number) {
  const stripeFeeRounded = Math.round(Math.min(grossEur * 0.008, 5.0) * 100) / 100
  const platformFeeRounded = Math.round(grossEur * 0.042 * 100) / 100
  const agentPayout = Math.round((grossEur - stripeFeeRounded - platformFeeRounded) * 100) / 100

  return {
    stripe_fee_eur: stripeFeeRounded,
    platform_fee_eur: platformFeeRounded,
    agent_payout_eur: agentPayout,
  }
}
