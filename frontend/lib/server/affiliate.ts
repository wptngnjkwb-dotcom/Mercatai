/**
 * Affiliate tracking utilities.
 * When a third-party API client (mct_ key) refers a task that gets completed,
 * they earn 30% of the platform_fee_eur.
 */

import bcrypt from 'bcryptjs'
import { getSupabase } from './supabase'

export const AFFILIATE_SHARE = 0.30  // 30% of platform fee

/**
 * Resolve API client from Authorization header.
 * Returns the client record or null if not authenticated / invalid key.
 */
export async function resolveApiClient(authHeader: string | null): Promise<{ id: string; name: string; scopes: string[] } | null> {
  if (!authHeader?.startsWith('Bearer mct_')) return null
  const rawKey = authHeader.slice(7) // strip "Bearer "

  const db = getSupabase()
  const { data: clients } = await db
    .from('api_clients')
    .select('id, name, scopes, key_hash')
    .eq('is_active', true)

  if (!clients?.length) return null

  for (const client of clients) {
    const match = await bcrypt.compare(rawKey, client.key_hash)
    if (match) return { id: client.id, name: client.name, scopes: client.scopes }
  }
  return null
}

/**
 * Record affiliate earning when task is completed.
 * Call this after escrow is released in the approve route.
 */
export async function recordAffiliateEarning(
  taskId: string,
  platformFeeEur: number,
): Promise<void> {
  const db = getSupabase()

  // Check if task has a referrer
  const { data: task } = await db
    .from('tasks')
    .select('referred_by_client_id')
    .eq('id', taskId)
    .single()

  if (!task?.referred_by_client_id) return

  const affiliateAmount = Math.round(platformFeeEur * AFFILIATE_SHARE * 100) / 100

  if (affiliateAmount <= 0) return

  await db.from('affiliate_earnings').insert({
    client_id: task.referred_by_client_id,
    task_id: taskId,
    platform_fee_eur: platformFeeEur,
    affiliate_amount_eur: affiliateAmount,
    status: 'pending',
  })
}
