import { describe, expect, it } from 'vitest'
import { computeVerifiedAgentStats } from '@/lib/server/verifiedAgentStats'

type Row = Record<string, any>

function fakeDb(seed: Record<string, Row[]>) {
  return {
    from(table: string) {
      return query(seed[table] ?? [])
    },
  }
}

function query(
  rows: Row[],
  eqFilters: Array<[string, unknown]> = [],
  inFilters: Array<[string, unknown[]]> = [],
  rangeBounds?: [number, number],
): any {
  const builder: any = {
    select: () => builder,
    eq: (field: string, value: unknown) => query(rows, [...eqFilters, [field, value]], inFilters, rangeBounds),
    in: (field: string, values: unknown[]) => query(rows, eqFilters, [...inFilters, [field, values]], rangeBounds),
    order: () => builder,
    range: (from: number, to: number) => query(rows, eqFilters, inFilters, [from, to]),
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      const filtered = rows.filter(row =>
        eqFilters.every(([field, value]) => row[field] === value)
        && inFilters.every(([field, values]) => values.includes(row[field]))
      )
      const ranged = rangeBounds ? filtered.slice(rangeBounds[0], rangeBounds[1] + 1) : filtered
      return Promise.resolve({ data: ranged, error: null }).then(resolve, reject)
    },
  }
  return builder
}

describe('computeVerifiedAgentStats', () => {
  it('counts only deduplicated, non-demo, non-internal, non-archived payment outcomes', async () => {
    const stats = await computeVerifiedAgentStats(fakeDb({
      transactions: [
        { id: 'tx-old', task_id: 'paid', agent_id: 'agent-1', escrow_status: 'refunded', created_at: '2026-01-01', released_at: null },
        { id: 'tx-paid', task_id: 'paid', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-02', released_at: '2026-01-03' },
        { id: 'tx-refund', task_id: 'refund', agent_id: 'agent-1', escrow_status: 'refunded', created_at: '2026-01-04', released_at: null },
        { id: 'tx-demo', task_id: 'demo', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-05', released_at: '2026-01-06' },
        { id: 'tx-pilot', task_id: 'pilot', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-07', released_at: '2026-01-08' },
        { id: 'tx-archived', task_id: 'archived', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-09', released_at: '2026-01-10' },
        { id: 'tx-other-agent', task_id: 'other', agent_id: 'agent-2', escrow_status: 'released', created_at: '2026-01-11', released_at: '2026-01-12' },
      ],
      tasks: [
        { id: 'paid', category: 'research', posted_by_org_id: 'real-org', source: 'marketplace', archived_at: null },
        { id: 'refund', category: 'content', posted_by_org_id: 'real-org', source: 'store', archived_at: null },
        { id: 'demo', category: 'research', posted_by_org_id: 'seed-org', source: 'marketplace', archived_at: null },
        { id: 'pilot', category: 'code_review', posted_by_org_id: 'real-org', source: 'internal_pilot', archived_at: null },
        { id: 'archived', category: 'finance', posted_by_org_id: 'real-org', source: 'marketplace', archived_at: '2026-02-01' },
      ],
      organizations: [
        { id: 'real-org', is_platform_seed: false },
        { id: 'seed-org', is_platform_seed: true },
      ],
      reviews: [
        { task_id: 'paid', agent_id: 'agent-1', rating: 5 },
        { task_id: 'refund', agent_id: 'agent-1', rating: 1 },
      ],
      quality_issues: [
        { task_id: 'paid' },
        { task_id: 'paid' },
        { task_id: 'refund' },
        { task_id: 'demo' },
      ],
    }), 'agent-1')

    expect(stats).toEqual({
      metrics_scope: 'released_or_refunded_non_demo_transactions',
      paid_tasks_completed: 1,
      refunded_tasks: 1,
      outcome_sample_size: 2,
      release_rate: 0.5,
      rated_tasks: 1,
      average_rating: 5,
      quality_issue_tasks: 2,
      completed_by_category: [{ category: 'research', count: 1 }],
    })
    expect(JSON.stringify(stats)).not.toContain('task_id')
    expect(JSON.stringify(stats)).not.toContain('tx-paid')
    expect(JSON.stringify(stats)).not.toContain('real-org')
  })

  it('returns an explicit empty sample instead of a misleading zero-percent rate', async () => {
    const stats = await computeVerifiedAgentStats(fakeDb({ transactions: [] }), 'agent-1')
    expect(stats.outcome_sample_size).toBe(0)
    expect(stats.release_rate).toBeNull()
    expect(stats.completed_by_category).toEqual([])
  })
})
