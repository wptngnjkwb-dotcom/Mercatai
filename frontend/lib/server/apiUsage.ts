/**
 * API usage tracking + plan enforcement.
 *
 * Plans:
 *   free    —  1 000 calls/month  — €0
 *   starter — 10 000 calls/month  — €19/month
 *   pro     — 100 000 calls/month — €79/month
 *
 * Usage is counted per calendar month (UTC).
 * Counting is fire-and-forget — never blocks the request.
 * Enforcement is checked synchronously (one fast DB read).
 */

import { getSupabase } from './supabase'

export const PLAN_LIMITS: Record<string, number> = {
  free:    1_000,
  starter: 10_000,
  pro:     100_000,
}

export const PLAN_PRICES: Record<string, { eur: number; stripe_price_id: string | null }> = {
  free:    { eur: 0,  stripe_price_id: null },
  starter: { eur: 19, stripe_price_id: process.env.STRIPE_PRICE_STARTER ?? null },
  pro:     { eur: 79, stripe_price_id: process.env.STRIPE_PRICE_PRO    ?? null },
}

function currentYearMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Check if a client has quota remaining for this month.
 * Returns { allowed: true } or { allowed: false, used, limit, plan }
 */
export async function checkQuota(clientId: string, plan: string): Promise<
  { allowed: true } | { allowed: false; used: number; limit: number; plan: string }
> {
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free
  const ym = currentYearMonth()
  const db = getSupabase()

  const { data } = await db
    .from('api_usage')
    .select('call_count')
    .eq('client_id', clientId)
    .eq('year_month', ym)
    .maybeSingle()

  const used = data?.call_count ?? 0
  if (used >= limit) return { allowed: false, used, limit, plan }
  return { allowed: true }
}

/**
 * Increment usage counter for a client. Fire-and-forget.
 * Uses a Postgres atomic upsert via RPC to avoid race conditions.
 */
export function trackApiCall(clientId: string): void {
  const ym = currentYearMonth()
  const db = getSupabase()
  db.rpc('increment_api_usage', { p_client_id: clientId, p_year_month: ym })
    .then(() => {})
    .catch(err => console.error('[apiUsage] increment failed', err))
}

/**
 * Get current month usage for a client.
 */
export async function getUsage(clientId: string): Promise<{ year_month: string; call_count: number }[]> {
  const db = getSupabase()
  const { data } = await db
    .from('api_usage')
    .select('year_month, call_count')
    .eq('client_id', clientId)
    .order('year_month', { ascending: false })
    .limit(6)
  return data ?? []
}
