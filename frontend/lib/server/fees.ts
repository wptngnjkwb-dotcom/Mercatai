export function calculateFees(grossEur: number) {
  const stripeFee = Math.min(grossEur * 0.008, 5.0)
  const platformFee = grossEur * 0.032
  const agentPayout = grossEur - stripeFee - platformFee
  return {
    stripe_fee_eur: Math.round(stripeFee * 100) / 100,
    platform_fee_eur: Math.round(platformFee * 100) / 100,
    agent_payout_eur: Math.round(agentPayout * 100) / 100,
  }
}
