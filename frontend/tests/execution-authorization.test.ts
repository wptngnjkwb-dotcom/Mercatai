import { describe, expect, it } from 'vitest'
import {
  computeExecutionDecision,
  callerAgentIdFromToken,
  fetchAgentBidTaskIds,
  NEXT_ACTIONS,
} from '@/lib/server/executionAuthorization'

// Pure-function tests only — no supabase mocking needed for
// computeExecutionDecision, so this file is safe to run alongside every
// other test file under vitest's isolate:false without any risk of
// cross-file mock collision. fetchAgentBidTaskIds is exercised below with
// a small hand-written fake db object passed directly as a parameter
// (same pattern as tests/public-task-fields.test.ts), never via vi.mock.

const AGENT = 'agent-1'
const OTHER_AGENT = 'agent-2'
const CLOSED_DECISION = { execution_authorized: false, next_action: 'closed' }

describe('computeExecutionDecision — canonical state table', () => {
  const base = { isDemo: false, callerAgentId: AGENT, assignedAgentId: AGENT, hasExistingBid: false }

  it.each([
    // [status, fundingStatus, expected next_action, expected execution_authorized]
    ['open', 'unfunded', 'submit_bid', false],
    ['bidding', 'unfunded', 'submit_bid', false],
    ['assigned', 'unfunded', 'await_funding', false],
    ['assigned', 'funding_pending', 'await_funding', false],
    ['in_progress', 'funded', 'perform_and_deliver', true],
    ['review', 'funded', 'await_review', false],
    ['completed', 'released', 'closed', false],
    ['disputed', 'funded', 'closed', false],
    ['cancelled', 'refunded', 'closed', false],
  ])('status=%s, funding_status=%s -> next_action=%s, execution_authorized=%s', (status, fundingStatus, expectedAction, expectedAuthorized) => {
    const decision = computeExecutionDecision({ ...base, status, fundingStatus })
    expect(decision.next_action).toBe(expectedAction)
    expect(decision.execution_authorized).toBe(expectedAuthorized)
  })

  it('is_demo=true always yields ignore_demo/false, overriding every other input — even in_progress+funded for the assigned agent', () => {
    const decision = computeExecutionDecision({ ...base, isDemo: true, status: 'in_progress', fundingStatus: 'funded' })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'ignore_demo' })
  })

  it('a released payment forces closed/false regardless of a stale/contradictory status', () => {
    const decision = computeExecutionDecision({ ...base, status: 'in_progress', fundingStatus: 'released' })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'closed' })
  })

  it('a refunded payment forces closed/false regardless of a stale/contradictory status', () => {
    const decision = computeExecutionDecision({ ...base, status: 'assigned', fundingStatus: 'refunded' })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'closed' })
  })

  it('an unrecognized status value fails closed', () => {
    const decision = computeExecutionDecision({ ...base, status: 'some-future-status', fundingStatus: 'funded' })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'closed' })
  })

  it.each(['funded', 'funding_pending', 'some-future-value'])(
    'open/bidding with contradictory funding_status=%s fails closed',
    (fundingStatus) => {
      for (const status of ['open', 'bidding']) {
        expect(computeExecutionDecision({ ...base, status, fundingStatus })).toEqual(CLOSED_DECISION)
      }
    }
  )

  it.each(['unfunded', 'funding_pending', 'some-future-value'])(
    'review with non-funded funding_status=%s fails closed',
    (fundingStatus) => {
      expect(computeExecutionDecision({ ...base, status: 'review', fundingStatus })).toEqual(CLOSED_DECISION)
    }
  )
})

describe('computeExecutionDecision — "assigned" alone never authorizes work', () => {
  it.each(['unfunded', 'funding_pending', 'funded', 'released', 'refunded'])(
    'status=assigned + funding_status=%s never yields execution_authorized=true',
    (fundingStatus) => {
      const decision = computeExecutionDecision({
        isDemo: false, status: 'assigned', fundingStatus, callerAgentId: AGENT, assignedAgentId: AGENT, hasExistingBid: false,
      })
      expect(decision.execution_authorized).toBe(false)
    }
  )
})

describe('computeExecutionDecision — "funded" without "in_progress" never authorizes work', () => {
  it.each(['open', 'bidding', 'assigned', 'review', 'completed', 'disputed', 'cancelled'])(
    'status=%s + funding_status=funded never yields execution_authorized=true',
    (status) => {
      const decision = computeExecutionDecision({
        isDemo: false, status, fundingStatus: 'funded', callerAgentId: AGENT, assignedAgentId: AGENT, hasExistingBid: false,
      })
      expect(decision.execution_authorized).toBe(false)
    }
  )
})

describe('computeExecutionDecision — "in_progress" without "funded" never authorizes work', () => {
  it.each(['unfunded', 'funding_pending', 'released', 'refunded', 'some-future-value'])(
    'status=in_progress + funding_status=%s never yields execution_authorized=true',
    (fundingStatus) => {
      const decision = computeExecutionDecision({
        isDemo: false, status: 'in_progress', fundingStatus, callerAgentId: AGENT, assignedAgentId: AGENT, hasExistingBid: false,
      })
      expect(decision.execution_authorized).toBe(false)
      // 'released'/'refunded' short-circuit to 'closed'; a genuinely
      // unrecognized combination ('unfunded'/'funding_pending'/anything
      // else while in_progress) also fails closed to 'closed' — never a
      // guess at some other next_action.
      expect(decision.next_action).toBe('closed')
    }
  )
})

describe('computeExecutionDecision — only the truly assigned, authenticated agent ever gets true', () => {
  const inProgressFunded = { isDemo: false, status: 'in_progress', fundingStatus: 'funded' }

  it('the assigned agent, authenticated as itself, gets true', () => {
    const decision = computeExecutionDecision({ ...inProgressFunded, callerAgentId: AGENT, assignedAgentId: AGENT, hasExistingBid: false })
    expect(decision).toEqual({ execution_authorized: true, next_action: 'perform_and_deliver' })
  })

  it('an anonymous caller (no token) never gets true for the same task', () => {
    const decision = computeExecutionDecision({ ...inProgressFunded, callerAgentId: null, assignedAgentId: AGENT, hasExistingBid: false })
    expect(decision.execution_authorized).toBe(false)
    expect(decision.next_action).toBe('closed')
  })

  it('a different agent\'s own token never gets true for the same task', () => {
    const decision = computeExecutionDecision({ ...inProgressFunded, callerAgentId: OTHER_AGENT, assignedAgentId: AGENT, hasExistingBid: false })
    expect(decision.execution_authorized).toBe(false)
    expect(decision.next_action).toBe('closed')
  })

  it('a buyer token (no agent_id, so callerAgentId is null) never gets true', () => {
    // Buyer tokens never carry agent_id — callerAgentIdFromToken(buyerToken)
    // is always null, so this is the same case as "anonymous" above, by
    // construction. Asserted explicitly here since the requirement
    // ("buyer token nikdy nesmí získat agentí oprávnění") is its own,
    // distinct rule even though the code path happens to be shared.
    const buyerToken = { role: 'buyer', task_id: 'task-1', org_id: 'org-1' }
    const decision = computeExecutionDecision({ ...inProgressFunded, callerAgentId: callerAgentIdFromToken(buyerToken), assignedAgentId: AGENT, hasExistingBid: false })
    expect(decision.execution_authorized).toBe(false)
  })

  it('an admin token (no agent_id, so callerAgentId is null) never gets true either', () => {
    const adminToken = { tier: 'admin' }
    const decision = computeExecutionDecision({ ...inProgressFunded, callerAgentId: callerAgentIdFromToken(adminToken), assignedAgentId: AGENT, hasExistingBid: false })
    expect(decision.execution_authorized).toBe(false)
  })

  it('no task has an assigned agent yet (assignedAgentId null) — never true even for a real agent token', () => {
    const decision = computeExecutionDecision({ ...inProgressFunded, callerAgentId: AGENT, assignedAgentId: null, hasExistingBid: false })
    expect(decision.execution_authorized).toBe(false)
  })
})

describe('computeExecutionDecision — bidding-phase branching', () => {
  it('no token at all on an open task -> authenticate', () => {
    const decision = computeExecutionDecision({ isDemo: false, status: 'open', fundingStatus: 'unfunded', callerAgentId: null, assignedAgentId: null, hasExistingBid: false })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'authenticate' })
  })

  it('an authenticated agent with no existing bid on a bidding task -> submit_bid', () => {
    const decision = computeExecutionDecision({ isDemo: false, status: 'bidding', fundingStatus: 'unfunded', callerAgentId: AGENT, assignedAgentId: null, hasExistingBid: false })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'submit_bid' })
  })

  it('an authenticated agent who already bid on a bidding task -> await_selection', () => {
    const decision = computeExecutionDecision({ isDemo: false, status: 'bidding', fundingStatus: 'unfunded', callerAgentId: AGENT, assignedAgentId: null, hasExistingBid: true })
    expect(decision).toEqual({ execution_authorized: false, next_action: 'await_selection' })
  })
})

describe('callerAgentIdFromToken', () => {
  it('returns null for no token', () => expect(callerAgentIdFromToken(null)).toBeNull())
  it('returns null for a buyer token', () => expect(callerAgentIdFromToken({ role: 'buyer', task_id: 't1' })).toBeNull())
  it('returns null for an admin token', () => expect(callerAgentIdFromToken({ tier: 'admin' })).toBeNull())
  it('returns the agent_id for a genuine agent token', () => expect(callerAgentIdFromToken({ agent_id: AGENT, tier: 1 })).toBe(AGENT))
  it('returns null when agent_id is present but not a string (defensive)', () => expect(callerAgentIdFromToken({ agent_id: 12345 } as any)).toBeNull())
})

describe('fetchAgentBidTaskIds — batched, no N+1', () => {
  function makeFakeBidsDb(rows: { task_id: string; agent_id: string }[]) {
    const calls: { agentId: unknown; taskIds: unknown[] }[] = []
    return {
      db: {
        from: (table: string) => {
          if (table !== 'bids') throw new Error(`unexpected table ${table}`)
          let agentIdFilter: unknown
          return {
            select: () => ({
              eq: (field: string, value: unknown) => {
                agentIdFilter = value
                return {
                  in: (_field: string, taskIds: unknown[]) => {
                    calls.push({ agentId: agentIdFilter, taskIds })
                    return Promise.resolve({
                      data: rows.filter((r) => r.agent_id === agentIdFilter && taskIds.includes(r.task_id)),
                      error: null,
                    })
                  },
                }
              },
            }),
          }
        },
      },
      calls,
    }
  }

  it('returns an empty set with zero queries when there is no agent identity', async () => {
    const { db, calls } = makeFakeBidsDb([{ task_id: 't1', agent_id: AGENT }])
    const result = await fetchAgentBidTaskIds(db as any, null, ['t1', 't2'])
    expect(result.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('returns an empty set with zero queries when there are no task ids', async () => {
    const { db, calls } = makeFakeBidsDb([{ task_id: 't1', agent_id: AGENT }])
    const result = await fetchAgentBidTaskIds(db as any, AGENT, [])
    expect(result.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('resolves exactly which of many task ids the agent bid on, in a single query — never one per task', async () => {
    const { db, calls } = makeFakeBidsDb([
      { task_id: 't1', agent_id: AGENT },
      { task_id: 't3', agent_id: AGENT },
      { task_id: 't2', agent_id: OTHER_AGENT },
    ])
    const taskIds = Array.from({ length: 50 }, (_, i) => `t${i}`)
    const result = await fetchAgentBidTaskIds(db as any, AGENT, taskIds)
    expect(calls).toHaveLength(1)
    expect(result.has('t1')).toBe(true)
    expect(result.has('t3')).toBe(true)
    expect(result.has('t2')).toBe(false)
  })

  it('chunks into multiple queries only past the chunk size, still far fewer than one per task', async () => {
    const { db, calls } = makeFakeBidsDb([{ task_id: 't100', agent_id: AGENT }])
    const taskIds = Array.from({ length: 450 }, (_, i) => `t${i}`)
    const result = await fetchAgentBidTaskIds(db as any, AGENT, taskIds)
    // 450 ids at a 200-per-chunk internal limit -> 3 calls, not 450.
    expect(calls.length).toBe(3)
    expect(result.has('t100')).toBe(true)
  })

  it('throws on a query error rather than silently returning "no existing bid"', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: null, error: new Error('db down') }),
          }),
        }),
      }),
    }
    await expect(fetchAgentBidTaskIds(db as any, AGENT, ['t1'])).rejects.toThrow('db down')
  })
})

describe('NEXT_ACTIONS — the single source of truth for every enum that must not drift', () => {
  it('lists exactly the 8 canonical values, in a stable order other code can rely on', () => {
    expect(NEXT_ACTIONS).toEqual([
      'ignore_demo', 'authenticate', 'submit_bid', 'await_selection',
      'await_funding', 'perform_and_deliver', 'await_review', 'closed',
    ])
  })

  it('every next_action computeExecutionDecision can return is a member of NEXT_ACTIONS', () => {
    const statuses = ['open', 'bidding', 'assigned', 'in_progress', 'review', 'completed', 'disputed', 'cancelled', 'unknown']
    const fundingStatuses = ['unfunded', 'funding_pending', 'funded', 'released', 'refunded', 'unknown']
    const agentIds = [null, AGENT, OTHER_AGENT]
    for (const status of statuses) {
      for (const fundingStatus of fundingStatuses) {
        for (const callerAgentId of agentIds) {
          for (const assignedAgentId of agentIds) {
            for (const isDemo of [true, false]) {
              for (const hasExistingBid of [true, false]) {
                const decision = computeExecutionDecision({ isDemo, status, fundingStatus, callerAgentId, assignedAgentId, hasExistingBid })
                expect(NEXT_ACTIONS).toContain(decision.next_action)
              }
            }
          }
        }
      }
    }
  })
})
