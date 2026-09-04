import { describe, expect, it } from 'vitest'
import { mapEscrowStatusToFundingStatus, attachPublicTaskFields, computeSettledMetrics } from '@/lib/server/publicTaskFields'

describe('mapEscrowStatusToFundingStatus', () => {
  it.each([
    ['pending', 'funding_pending'],
    ['held', 'funded'],
    ['released', 'released'],
    ['refunded', 'refunded'],
    ['failed', 'unfunded'],
    // 'disputed' is in the DB CHECK constraint and the Transaction type but
    // is never actually set by the live app (tasks.status='disputed' is the
    // real dispute marker; the transaction itself stays 'held') — handled
    // defensively as still-funded, since a dispute doesn't move money out.
    ['disputed', 'funded'],
    [null, 'unfunded'],
    [undefined, 'unfunded'],
    ['not-a-real-status', 'unfunded'],
  ])('maps escrow_status %s to funding_status %s', (escrowStatus, expected) => {
    expect(mapEscrowStatusToFundingStatus(escrowStatus as any)).toBe(expected)
  })
})

function makeFakeDb(orgs: { id: string; is_platform_seed: boolean }[], transactions: { task_id: string; escrow_status: string }[]) {
  const calls: string[] = []
  return {
    from(table: string) {
      calls.push(table)
      return {
        select: () => ({
          in: () =>
            Promise.resolve({
              data: table === 'organizations' ? orgs : table === 'transactions' ? transactions : [],
              error: null,
            }),
        }),
      }
    },
    _calls: calls,
  } as any
}

describe('attachPublicTaskFields', () => {
  it('is_demo is derived only from organizations.is_platform_seed — task/title text is never consulted', async () => {
    const db = makeFakeDb(
      [
        { id: 'org-seed', is_platform_seed: true },
        { id: 'org-real', is_platform_seed: false },
      ],
      []
    )
    const tasks = [
      { id: 't1', posted_by_org_id: 'org-seed', title: 'Totally real paid task, I promise' },
      { id: 't2', posted_by_org_id: 'org-real', title: 'Mercatai Sample Briefs — demo task' },
    ]
    const result = await attachPublicTaskFields(db, tasks)
    expect(result.find((t) => t.id === 't1')?.is_demo).toBe(true)
    expect(result.find((t) => t.id === 't2')?.is_demo).toBe(false)
  })

  it('a task with no posted_by_org_id, or no matching organization row, defaults to is_demo: false', async () => {
    const db = makeFakeDb([], [])
    const result = await attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: undefined }])
    expect(result[0].is_demo).toBe(false)
  })

  it('queries organizations and transactions exactly once each for a whole page of tasks — no N+1', async () => {
    const db = makeFakeDb([{ id: 'org-1', is_platform_seed: false }], [])
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, posted_by_org_id: 'org-1' }))
    await attachPublicTaskFields(db, tasks)
    expect(db._calls.filter((t: string) => t === 'organizations')).toHaveLength(1)
    expect(db._calls.filter((t: string) => t === 'transactions')).toHaveLength(1)
  })

  it('picks the higher-priority transaction when a task has more than one row (e.g. a failed retry then a funded one)', async () => {
    const db = makeFakeDb(
      [],
      [
        { task_id: 't1', escrow_status: 'failed' },
        { task_id: 't1', escrow_status: 'held' },
      ]
    )
    const result = await attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: undefined }])
    expect(result[0].funding_status).toBe('funded')
  })
})

describe('computeSettledMetrics', () => {
  function makeSettledFakeDb(
    transactions: { task_id: string; gross_amount_eur: number; released_at: string }[],
    tasks: { id: string; posted_by_org_id: string }[],
    orgs: { id: string; is_platform_seed: boolean }[]
  ) {
    return {
      from(table: string) {
        return {
          select: () => ({
            eq: () => ({ limit: () => Promise.resolve({ data: transactions, error: null }) }),
            in: () =>
              Promise.resolve({
                data: table === 'tasks' ? tasks : table === 'organizations' ? orgs : [],
                error: null,
              }),
          }),
        }
      },
    } as any
  }

  it('sums distinct non-demo tasks’ released amounts and excludes a demo task even with a larger amount', async () => {
    const db = makeSettledFakeDb(
      [
        { task_id: 'real-1', gross_amount_eur: 30, released_at: '2026-08-01T00:00:00Z' },
        { task_id: 'real-2', gross_amount_eur: 50, released_at: '2026-08-02T00:00:00Z' },
        { task_id: 'demo-1', gross_amount_eur: 9999, released_at: '2026-08-03T00:00:00Z' },
      ],
      [
        { id: 'real-1', posted_by_org_id: 'org-real' },
        { id: 'real-2', posted_by_org_id: 'org-real' },
        { id: 'demo-1', posted_by_org_id: 'org-seed' },
      ],
      [
        { id: 'org-real', is_platform_seed: false },
        { id: 'org-seed', is_platform_seed: true },
      ]
    )
    const result = await computeSettledMetrics(db)
    expect(result.tasksCompleted).toBe(2)
    expect(result.gmvEur).toBe(80)
  })

  it('returns zero for both fields when there are no released transactions at all', async () => {
    const db = makeSettledFakeDb([], [], [])
    const result = await computeSettledMetrics(db)
    expect(result).toEqual({ tasksCompleted: 0, gmvEur: 0 })
  })
})
