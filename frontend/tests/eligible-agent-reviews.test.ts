import { describe, expect, it } from 'vitest'
import { fetchEligibleAgentReviews } from '@/lib/server/eligibleAgentReviews'

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

describe('fetchEligibleAgentReviews', () => {
  it('returns one newest review per released real task and excludes every non-public outcome class', async () => {
    const reviews = await fetchEligibleAgentReviews(fakeDb({
      reviews: [
        { id: 'real-old', task_id: 'real', agent_id: 'agent-1', rating: 2, text: 'old', created_at: '2026-01-01' },
        { id: 'real-new', task_id: 'real', agent_id: 'agent-1', rating: 5, text: 'new', created_at: '2026-01-02' },
        { id: 'pilot-review', task_id: 'pilot', agent_id: 'agent-1', rating: 5, text: 'pilot', created_at: '2026-01-03' },
        { id: 'seed-review', task_id: 'seed', agent_id: 'agent-1', rating: 5, text: 'seed', created_at: '2026-01-04' },
        { id: 'archived-review', task_id: 'archived', agent_id: 'agent-1', rating: 5, text: 'archived', created_at: '2026-01-05' },
        { id: 'refund-review', task_id: 'refund', agent_id: 'agent-1', rating: 1, text: 'refund', created_at: '2026-01-06' },
        { id: 'other-review', task_id: 'other', agent_id: 'agent-2', rating: 1, text: 'other', created_at: '2026-01-07' },
      ],
      tasks: [
        { id: 'real', posted_by_org_id: 'real-org', source: 'store', archived_at: null },
        { id: 'pilot', posted_by_org_id: 'real-org', source: 'internal_pilot', archived_at: null },
        { id: 'seed', posted_by_org_id: 'seed-org', source: 'marketplace', archived_at: null },
        { id: 'archived', posted_by_org_id: 'real-org', source: 'marketplace', archived_at: '2026-02-01' },
        { id: 'refund', posted_by_org_id: null, source: 'marketplace', archived_at: null },
      ],
      organizations: [
        { id: 'real-org', is_platform_seed: false },
        { id: 'seed-org', is_platform_seed: true },
      ],
      transactions: [
        { id: 'tx-real', task_id: 'real', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
        { id: 'tx-pilot', task_id: 'pilot', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
        { id: 'tx-seed', task_id: 'seed', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
        { id: 'tx-archived', task_id: 'archived', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
        { id: 'tx-refund-old', task_id: 'refund', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
        { id: 'tx-refund-new', task_id: 'refund', escrow_status: 'refunded', created_at: '2026-01-03', released_at: null },
      ],
    }), 'agent-1')

    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      id: 'real-new', task_id: 'real', rating: 5, text: 'new', created_at: '2026-01-02',
    })
  })
})
