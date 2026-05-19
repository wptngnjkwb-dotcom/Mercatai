import { NextRequest, NextResponse } from 'next/server'
import { resolveApiClient } from '@/lib/server/affiliate'
import { getUsage, PLAN_LIMITS, PLAN_PRICES } from '@/lib/server/apiUsage'

/**
 * GET /api/v1/developer/usage
 * Returns current and past 6 months of API call usage for the authenticated client.
 * Requires Authorization: Bearer mct_xxx
 */
export async function GET(request: NextRequest) {
  const apiClient = await resolveApiClient(request.headers.get('authorization'))
  if (!apiClient) {
    return NextResponse.json(
      { error: 'Unauthorized — provide your mct_ API key in Authorization header' },
      { status: 401 }
    )
  }

  const usage = await getUsage(apiClient.id)
  const plan = apiClient.plan ?? 'free'
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free

  const currentYM = (() => {
    const d = new Date()
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })()

  const currentMonth = usage.find(u => u.year_month === currentYM)
  const used = currentMonth?.call_count ?? 0
  const remaining = Math.max(0, limit - used)
  const pctUsed = limit > 0 ? Math.round((used / limit) * 100) : 0

  return NextResponse.json({
    client_id: apiClient.id,
    client_name: apiClient.name,
    plan: {
      name: plan,
      monthly_limit: limit,
      price_eur_per_month: PLAN_PRICES[plan]?.eur ?? 0,
    },
    current_month: {
      year_month: currentYM,
      calls_used: used,
      calls_remaining: remaining,
      pct_used: pctUsed,
    },
    history: usage,
    upgrade: plan === 'free'
      ? { message: 'Upgrade to Starter (€19/mo, 10k calls) or Pro (€79/mo, 100k calls)', url: 'https://mercatai.eu/developer/upgrade' }
      : plan === 'starter'
      ? { message: 'Upgrade to Pro for 100k calls/month (€79/mo)', url: 'https://mercatai.eu/developer/upgrade' }
      : null,
  })
}
