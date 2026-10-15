import { describe, expect, it } from 'vitest'
import { computeVerifiedAgentStats } from '@/lib/server/verifiedAgentStats'

// Complements verified-agent-stats.test.ts. Mutation-checked: the original
// scenario never exercised agent isolation (the other agent's task row was
// missing, so it was dropped for the wrong reason), tasks without an
// organization, or the 1,000-row page / 200-id chunk boundaries.
type Row = Record<string, any>

function fakeDb(seed: Record<string, Row[]>) {
  return { from: (table: string) => query(seed[table] ?? []) }
}

function query(
  rows: Row[],
  eqFilters: Array<[string, unknown]> = [],
  inFilters: Array<[string, Set<unknown>]> = [],
  rangeBounds?: [number, number],
): any {
  const builder: any = {
    select: () => builder,
    order: () => builder,
    eq: (field: string, value: unknown) => query(rows, [...eqFilters, [field, value]], inFilters, rangeBounds),
    in: (field: string, values: unknown[]) => query(rows, eqFilters, [...inFilters, [field, new Set(values)]], rangeBounds),
    range: (from: number, to: number) => query(rows, eqFilters, inFilters, [from, to]),
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      const filtered = rows.filter(row =>
        eqFilters.every(([field, value]) => row[field] === value)
        && inFilters.every(([field, values]) => values.has(row[field]))
      )
      const ranged = rangeBounds ? filtered.slice(rangeBounds[0], rangeBounds[1] + 1) : filtered
      return Promise.resolve({ data: ranged, error: null }).then(resolve, reject)
    },
  }
  return builder
}

const realOrg = [{ id: 'org', is_platform_seed: false }]

describe('computeVerifiedAgentStats — isolation between agents', () => {
  it('never counts another agent\'s payments, even when that agent\'s task rows exist', async () => {
    const stats = await computeVerifiedAgentStats(fakeDb({
      transactions: [
        { id: 'a1', task_id: 'mine', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
        { id: 'a2', task_id: 'theirs', agent_id: 'agent-2', escrow_status: 'released', created_at: '2026-01-03', released_at: '2026-01-04' },
        { id: 'a3', task_id: 'theirs-refunded', agent_id: 'agent-2', escrow_status: 'refunded', created_at: '2026-01-05', released_at: null },
      ],
      tasks: [
        { id: 'mine', category: 'research', posted_by_org_id: 'org', source: 'marketplace', archived_at: null },
        { id: 'theirs', category: 'finance', posted_by_org_id: 'org', source: 'marketplace', archived_at: null },
        { id: 'theirs-refunded', category: 'content', posted_by_org_id: 'org', source: 'marketplace', archived_at: null },
      ],
      organizations: realOrg,
      reviews: [{ id: 'mine-review', task_id: 'mine', agent_id: 'agent-1', rating: 4, created_at: '2026-01-05' }],
    }), 'agent-1')

    expect(stats.paid_tasks_completed).toBe(1)
    expect(stats.refunded_tasks).toBe(0)
    expect(stats.completed_by_category).toEqual([{ category: 'research', count: 1 }])
  })

  it('ignores reviews written for a different agent, including on this agent\'s task', async () => {
    const stats = await computeVerifiedAgentStats(fakeDb({
      transactions: [
        { id: 'a1', task_id: 'mine', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
      ],
      tasks: [{ id: 'mine', category: 'research', posted_by_org_id: 'org', source: 'marketplace', archived_at: null }],
      organizations: realOrg,
      reviews: [
        { id: 'mine-review', task_id: 'mine', agent_id: 'agent-1', rating: 5, created_at: '2026-01-05' },
        { id: 'other-review', task_id: 'mine', agent_id: 'agent-2', rating: 1, created_at: '2026-01-06' },
      ],
    }), 'agent-1')

    expect(stats.rated_tasks).toBe(1)
    expect(stats.average_rating).toBe(5)
  })
})

describe('computeVerifiedAgentStats — tasks without an organization', () => {
  it('stay eligible: no organization means there is no seed organization to exclude', async () => {
    const stats = await computeVerifiedAgentStats(fakeDb({
      transactions: [
        { id: 'a1', task_id: 'no-org', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
      ],
      tasks: [{ id: 'no-org', category: 'research', posted_by_org_id: null, source: 'store', archived_at: null }],
      organizations: [],
    }), 'agent-1')

    expect(stats.paid_tasks_completed).toBe(1)
  })
})

describe('computeVerifiedAgentStats — page and chunk boundaries', () => {
  // 2,401 = two full 1,000-row payment pages plus a partial one, and twelve
  // full 200-id lookup chunks plus one.
  const TOTAL = 2401

  it('counts every payment and task across all pages and lookup chunks', async () => {
    const transactions = Array.from({ length: TOTAL }, (_, i) => ({
      id: `tx-${String(i).padStart(5, '0')}`, task_id: `task-${i}`, agent_id: 'agent-1',
      escrow_status: i % 4 === 0 ? 'refunded' : 'released',
      created_at: '2026-01-01', released_at: i % 4 === 0 ? null : '2026-01-02',
    }))
    const tasks = Array.from({ length: TOTAL }, (_, i) => ({
      id: `task-${i}`, category: i % 2 === 0 ? 'research' : 'content', posted_by_org_id: 'org', source: 'marketplace', archived_at: null,
    }))
    const stats = await computeVerifiedAgentStats(fakeDb({ transactions, tasks, organizations: realOrg }), 'agent-1')

    const refunded = Math.ceil(TOTAL / 4)
    expect(stats.refunded_tasks).toBe(refunded)
    expect(stats.paid_tasks_completed).toBe(TOTAL - refunded)
    expect(stats.outcome_sample_size).toBe(TOTAL)
    expect(stats.completed_by_category.reduce((sum, c) => sum + c.count, 0)).toBe(TOTAL - refunded)
  })
})
