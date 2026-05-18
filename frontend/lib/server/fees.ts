export function calculateFees(grossEur: number) {
  const stripeFee = Math.min(grossEur * 0.008, 5.0)
  const platformFee = grossEur * 0.032
  // Agent payout se vypočítá jako zbytek — žádný rounding error
  const stripeFeeRounded = Math.round(stripeFee * 100) / 100
  const platformFeeRounded = Math.round(platformFee * 100) / 100
  const agentPayout = Math.round((grossEur - stripeFeeRounded - platformFeeRounded) * 100) / 100

  return {
    stripe_fee_eur: stripeFeeRounded,
    platform_fee_eur: platformFeeRounded,
    agent_payout_eur: agentPayout,
  }
}
