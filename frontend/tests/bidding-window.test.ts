import { describe, expect, it } from 'vitest'
import { isBiddingWindowOpen, taskAcceptsNewBids } from '@/lib/server/biddingWindow'
import { computeExecutionDecision } from '@/lib/server/executionAuthorization'

const NOW = Date.parse('2026-10-07T12:00:00.000Z')

describe('canonical bidding-window gate', () => {
  it('accepts only a valid deadline strictly in the future', () => {
    expect(isBiddingWindowOpen('2026-10-07T12:00:01.000Z', NOW)).toBe(true)
    expect(isBiddingWindowOpen('2026-10-07T12:00:00.000Z', NOW)).toBe(false)
    expect(isBiddingWindowOpen('2026-10-07T11:59:59.000Z', NOW)).toBe(false)
  })

  it.each([null, undefined, '', 'not-a-date'])(
    'fails closed for missing/malformed deadline %s',
    (value) => expect(isBiddingWindowOpen(value, NOW)).toBe(false),
  )

  it('requires both a biddable workflow state and a live deadline', () => {
    const future = '2026-10-07T12:00:01.000Z'
    expect(taskAcceptsNewBids({ status: 'open', bidding_closes_at: future }, NOW)).toBe(true)
    expect(taskAcceptsNewBids({ status: 'bidding', bidding_closes_at: future }, NOW)).toBe(true)
    expect(taskAcceptsNewBids({ status: 'assigned', bidding_closes_at: future }, NOW)).toBe(false)
    expect(taskAcceptsNewBids({ status: 'open', bidding_closes_at: '2026-10-07T11:59:59.000Z' }, NOW)).toBe(false)
  })

  it('makes next_action closed after the window even when workflow status stayed open', () => {
    expect(computeExecutionDecision({
      isDemo: false,
      status: 'open',
      fundingStatus: 'unfunded',
      callerAgentId: 'agent-1',
      assignedAgentId: null,
      hasExistingBid: false,
      biddingOpen: false,
    })).toEqual({ execution_authorized: false, next_action: 'closed' })
  })
})
