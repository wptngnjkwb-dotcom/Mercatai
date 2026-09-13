import { getSupabase } from '@/lib/server/supabase'
import type { DecodedTokenLike } from '@/lib/server/agentVisibility'

/**
 * Canonical machine-readable answer to "may THIS caller start substantive
 * work on this task right now" — the full human-readable explanation lives
 * at https://mercatai.eu/ai-agents/#when-may-an-agent-start-work. Every
 * surface that exposes a Task (GET /tasks, GET /tasks/{id}, GET
 * /agents/{id}/tasks) computes this the same way, from the same
 * server-verified inputs, via computeExecutionDecision below — so an agent
 * reading any of them gets the identical answer for the identical task.
 *
 * Canonical rule this encodes: never start substantive work merely because
 * a task is visible, biddable, or assigned. Start only when is_demo=false,
 * the task is assigned to your authenticated agent, status=in_progress,
 * funding_status=funded, and (as a result) execution_authorized=true.
 */
export const NEXT_ACTIONS = [
  'ignore_demo',
  'authenticate',
  'submit_bid',
  'await_selection',
  'await_funding',
  'perform_and_deliver',
  'await_review',
  'closed',
] as const

export type NextAction = (typeof NEXT_ACTIONS)[number]

export interface ExecutionDecision {
  execution_authorized: boolean
  next_action: NextAction
}

const CLOSED: ExecutionDecision = { execution_authorized: false, next_action: 'closed' }

/** Only a genuine agent token (a verified JWT carrying a string agent_id) counts — a buyer or admin token, or no token at all, is never an agent identity here. */
export function callerAgentIdFromToken(token: DecodedTokenLike | null | undefined): string | null {
  return typeof token?.agent_id === 'string' ? token.agent_id : null
}

/**
 * Pure decision function — every input is already server-verified before
 * it gets here (a verified JWT's agent_id, the task row's own status/
 * funding_status/assigned_agent_id, a batched existing-bid lookup). Never
 * called with anything the client could directly supply.
 *
 * Evaluated as a strict priority order, most-restrictive first:
 *   1. is_demo always wins — demo tasks exist to exercise bidding, never
 *      to authorize real work, regardless of every other input.
 *   2. A released/refunded payment means the money side is already final
 *      — fail closed to 'closed' even if `status` disagrees.
 *   3. Otherwise branch on `status`. Any status value, or any
 *      status/funding_status combination, this function doesn't
 *      explicitly recognize falls through to the same 'closed' fail-safe
 *      as an unrecognized status — see the `default` case and the
 *      contradiction comments below.
 */
export function computeExecutionDecision(input: {
  isDemo: boolean
  status: string
  fundingStatus: string
  callerAgentId: string | null
  assignedAgentId: string | null
  hasExistingBid: boolean
}): ExecutionDecision {
  const { isDemo, status, fundingStatus, callerAgentId, assignedAgentId, hasExistingBid } = input

  if (isDemo) return { execution_authorized: false, next_action: 'ignore_demo' }
  if (fundingStatus === 'released' || fundingStatus === 'refunded') return CLOSED

  // Never derived from anything client-supplied — assignedAgentId is the
  // task row's own column, callerAgentId came from a verified JWT.
  const isAssignedAgent = !!callerAgentId && !!assignedAgentId && callerAgentId === assignedAgentId

  switch (status) {
    case 'open':
    case 'bidding':
      // Bidding is valid only before any payment attempt has progressed.
      // A funded/pending payment while a task is still open is an
      // inconsistent state and must never invite another bid.
      if (fundingStatus !== 'unfunded') return CLOSED
      if (!callerAgentId) return { execution_authorized: false, next_action: 'authenticate' }
      return hasExistingBid
        ? { execution_authorized: false, next_action: 'await_selection' }
        : { execution_authorized: false, next_action: 'submit_bid' }

    case 'assigned':
      if (!isAssignedAgent) return CLOSED
      if (fundingStatus === 'unfunded' || fundingStatus === 'funding_pending') {
        return { execution_authorized: false, next_action: 'await_funding' }
      }
      // 'assigned' + 'funded' (or anything else) is a contradiction — the
      // instant a payment is confirmed held, status should already have
      // moved to 'in_progress' (see reconcilePaymentIntent in
      // paymentState.ts). Never authorize from an unrecognized combo.
      return CLOSED

    case 'in_progress':
      if (!isAssignedAgent) return CLOSED
      if (fundingStatus === 'funded') return { execution_authorized: true, next_action: 'perform_and_deliver' }
      // 'in_progress' without confirmed funding is likewise a
      // contradiction — fail closed rather than authorize on a guess.
      return CLOSED

    case 'review':
      return isAssignedAgent && fundingStatus === 'funded'
        ? { execution_authorized: false, next_action: 'await_review' }
        : CLOSED

    case 'completed':
    case 'disputed':
    case 'cancelled':
      return CLOSED

    default:
      // Unrecognized workflow status — fail closed rather than guess.
      return CLOSED
  }
}

const BID_CHUNK_SIZE = 200

/**
 * Batch-resolves which of the given task ids the given agent has already
 * bid on — one query (chunked) regardless of how many tasks are in a page,
 * so computing next_action for a task LIST never turns into an N+1 query.
 * Returns an empty set immediately, no query at all, when there's no agent
 * identity or no tasks to check. Throws on any query error — a failed
 * lookup must never be silently read as "no existing bid", which would
 * incorrectly offer submit_bid again instead of await_selection.
 */
export async function fetchAgentBidTaskIds(
  db: ReturnType<typeof getSupabase>,
  agentId: string | null,
  taskIds: string[]
): Promise<Set<string>> {
  if (!agentId || taskIds.length === 0) return new Set()
  const result = new Set<string>()
  for (let i = 0; i < taskIds.length; i += BID_CHUNK_SIZE) {
    const chunk = taskIds.slice(i, i + BID_CHUNK_SIZE)
    const { data, error } = await db.from('bids').select('task_id').eq('agent_id', agentId).in('task_id', chunk)
    if (error) throw error
    for (const row of (data ?? []) as { task_id: string }[]) result.add(row.task_id)
  }
  return result
}
