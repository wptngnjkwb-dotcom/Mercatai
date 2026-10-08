import type { getSupabase } from '@/lib/server/supabase'
import type { DecodedTokenLike } from '@/lib/server/agentVisibility'

/**
 * Delivered work (tasks.delivery_note) is private to the parties of a task.
 * It may be read only by:
 *   - the task's own buyer — a buyer token bound to this exact task
 *     (role === 'buyer' && task_id === task.id), the same task-scoped
 *     credential that authorizes approve, quality issues and payment;
 *   - the assigned agent — its own verified token
 *     (agent_id === task.assigned_agent_id, using the REAL, unmasked
 *     column value);
 *   - an admin token (tier === 'admin').
 * Everyone else — anonymous callers, other agents, a buyer token for a
 * different task, OAuth tokens (whose agent_id is a slug, not the UUID) —
 * gets the unchanged public task shape. Missing or malformed claims fail
 * closed.
 */
export function canReadDeliveredWork(
  token: DecodedTokenLike | null | undefined,
  task: { id: string; assigned_agent_id?: string | null }
): boolean {
  if (!token) return false
  if (token.tier === 'admin') return true
  if (token.role === 'buyer') {
    return typeof token.task_id === 'string' && token.task_id === task.id
  }
  return typeof token.agent_id === 'string'
    && typeof task.assigned_agent_id === 'string'
    && token.agent_id === task.assigned_agent_id
}

/**
 * Returns `{ delivery_note }` for an authorized caller, or `null` — meaning
 * "respond with the public shape" — for everyone else AND for any lookup
 * failure. delivery_note is read in its own query, never added to the public
 * projection, so an unauthorized request never even loads it.
 */
export async function fetchDeliveredWorkFor(
  db: ReturnType<typeof getSupabase>,
  token: DecodedTokenLike | null | undefined,
  task: { id: string; assigned_agent_id?: string | null }
): Promise<{ delivery_note: string | null } | null> {
  if (!canReadDeliveredWork(token, task)) return null
  try {
    const { data, error } = await db.from('tasks').select('delivery_note').eq('id', task.id).single()
    if (error || !data) {
      if (error) console.error('[tasks] delivered work lookup failed', error)
      return null
    }
    const note = (data as { delivery_note?: unknown }).delivery_note
    return { delivery_note: typeof note === 'string' ? note : null }
  } catch (err) {
    console.error('[tasks] delivered work lookup failed', err)
    return null
  }
}
