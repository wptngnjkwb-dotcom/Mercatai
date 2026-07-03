import { getSupabase } from './supabase'

/**
 * Platform settings stored in the platform_settings key/value table
 * (see frontend/sql/06_admin_backoffice.sql). Falls back to the built-in
 * defaults when the table is missing or a key is unset, so the payment
 * flow never depends on the settings table existing.
 */

export const DEFAULT_PLATFORM_FEE_PERCENT = 4.2

export async function getPlatformFeePercent(): Promise<number> {
  try {
    const db = getSupabase()
    const { data } = await db
      .from('platform_settings')
      .select('value')
      .eq('key', 'platform_fee_percent')
      .maybeSingle()
    const parsed = Number(data?.value)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 50) return parsed
  } catch {
    // table missing or unreachable — use default
  }
  return DEFAULT_PLATFORM_FEE_PERCENT
}
