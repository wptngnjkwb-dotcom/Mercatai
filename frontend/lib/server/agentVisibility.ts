/**
 * Single shared decision for whether a caller may see a private agent's
 * profile-adjacent data (profile, reputation, reviews, portfolio, work
 * history) or a specific bid it placed. Every route that needs this check
 * must call this instead of inlining its own — that's how the previous
 * fee/KYC/escrow accuracy pass caught duplicated, drifting authorization
 * logic in this codebase, and it applies just as much here.
 *
 * Only an agent explicitly marked `public` is publicly visible. Missing or
 * unknown values fail closed: they can still be seen by the agent itself or
 * an admin, but never by an anonymous caller. A private
 * agent is visible only to:
 *   - an admin token (tier === 'admin')
 *   - the agent's own token (agent_id === agent.id)
 *   - for bid-level visibility only (pass taskId) — a buyer token bound to
 *     the task the agent bid on (role === 'buyer' && task_id === taskId).
 *     General profile access (agent detail, reputation, reviews,
 *     portfolio, task history) never grants buyers this — only the bids
 *     endpoint, which passes taskId, does.
 *
 * A developer API key (mct_...) never reaches this function as a `token`
 * at all — it's resolved through a completely separate mechanism
 * (resolveApiClient) that never produces a JWT payload with agent_id/tier/
 * role, so it can't accidentally satisfy any of the branches above. Another
 * agent's own token likewise fails every branch (different agent_id, no
 * role/task_id match).
 *
 * Callers needing the 404-not-403 behavior this exists to support should
 * do: `if (!isAgentVisibleTo(token, agent)) return 404`. Returning 403
 * instead would itself confirm a hidden agent exists.
 */

import type { getSupabase } from '@/lib/server/supabase'

export interface DecodedTokenLike {
  agent_id?: unknown
  tier?: unknown
  role?: unknown
  task_id?: unknown
  // Every real caller is a decoded JWTPayload (jose), which carries this
  // same catch-all index signature — without it here too, TypeScript's
  // weak-type detection rejects the assignment (a JWTPayload and a
  // hand-written all-optional interface are otherwise seen as sharing no
  // properties, even though every field below is a subset of it).
  [claim: string]: unknown
}

export interface AgentVisibilityRow {
  id: string
  profile_visibility?: string | null
}

export function isAgentVisibleTo(
  token: DecodedTokenLike | null | undefined,
  agent: AgentVisibilityRow,
  options?: { taskId?: string }
): boolean {
  if (agent.profile_visibility === 'public') return true
  if (!token) return false
  if (token.tier === 'admin') return true
  if (typeof token.agent_id === 'string' && token.agent_id === agent.id) return true
  if (
    agent.profile_visibility === 'private'
    && options?.taskId
    && token.role === 'buyer'
    && token.task_id === options.taskId
  ) return true
  return false
}

/**
 * Looks up just enough of an agent row to decide visibility. Several routes
 * (reviews, portfolio, work-history) had no per-agent existence check at
 * all before this feature — they queried a child table by agent_id and
 * happily returned an empty list for a typo'd or nonexistent id. Those
 * routes now need this lookup first so a private agent's id doesn't
 * silently keep working through them.
 */
export async function fetchAgentVisibilityRow(
  db: ReturnType<typeof getSupabase>,
  agentId: string
): Promise<AgentVisibilityRow | null> {
  const { data, error } = await db.from('agents').select('id, profile_visibility').eq('id', agentId).single()
  if (error && (error as { code?: string }).code !== 'PGRST116') throw error
  return data
}

const AGENT_VISIBILITY_CHUNK_SIZE = 200

/**
 * Batch version of fetchAgentVisibilityRow, for pages of tasks/bids that
 * reference many distinct agents at once — one query regardless of page
 * size, so masking a private assigned_agent_id in a task LIST never turns
 * into an N+1 lookup.
 */
export async function fetchAgentVisibilityRows(
  db: ReturnType<typeof getSupabase>,
  agentIds: string[]
): Promise<Map<string, AgentVisibilityRow>> {
  const uniqueIds = Array.from(new Set(agentIds))
  const result = new Map<string, AgentVisibilityRow>()
  for (let i = 0; i < uniqueIds.length; i += AGENT_VISIBILITY_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + AGENT_VISIBILITY_CHUNK_SIZE)
    if (chunk.length === 0) continue
    const { data, error } = await db.from('agents').select('id, profile_visibility').in('id', chunk)
    if (error) throw error
    for (const row of data ?? []) result.set(row.id, row)
  }
  return result
}

/**
 * `fireWebhooks()` fans the identical payload out to every third-party
 * developer client subscribed to an event — there is no per-subscriber
 * distinction, so a private agent's id must never be in that payload at
 * all, for anyone. (An agent's own push-notification webhook — the
 * separate agents.webhook_url/webhook_secret mechanism used by autobid.ts
 * — never goes through fireWebhooks, so there is no "but let the agent see
 * its own id" case to preserve here.) Spread the result into a
 * fireWebhooks(...) payload: `{ ...(await agentIdentityForWebhook(db, id)) }`.
 */
export async function agentIdentityForWebhook(
  db: ReturnType<typeof getSupabase>,
  agentId: string | null | undefined
): Promise<{ agent_id: string } | { agent_private: true } | {}> {
  if (!agentId) return {}
  try {
    const agent = await fetchAgentVisibilityRow(db, agentId)
    // Only a positively verified public row may leave the platform in a
    // third-party webhook. Missing rows, query failures, and future/invalid
    // visibility values all redact rather than leak the identifier.
    return agent?.profile_visibility === 'public'
      ? { agent_id: agentId }
      : { agent_private: true }
  } catch (error) {
    console.error('Failed to resolve agent visibility for webhook; redacting identity', error)
    return { agent_private: true }
  }
}

/** Sets the headers required on any response whose content depends on the caller's identity, so it can never be served from a shared/public cache. */
export function withPrivateCacheHeaders<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('Vary', 'Authorization')
  return response
}
