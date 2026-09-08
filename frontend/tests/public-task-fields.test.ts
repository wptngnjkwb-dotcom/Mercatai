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

function makeFakeDb(
  orgs: { id: string; is_platform_seed: boolean }[] | { error: unknown },
  transactions: { id: string; task_id: string; escrow_status: string; created_at: string }[] | { error: unknown },
  agents: { id: string; profile_visibility?: string | null }[] | { error: unknown } = []
) {
  const calls: string[] = []
  return {
    from(table: string) {
      calls.push(table)
      return {
        select: () => ({
          in: () => {
            if (table === 'organizations') {
              return Promise.resolve(Array.isArray(orgs) ? { data: orgs, error: null } : { data: null, error: orgs.error })
            }
            if (table === 'transactions') {
              return Promise.resolve(
                Array.isArray(transactions) ? { data: transactions, error: null } : { data: null, error: transactions.error }
              )
            }
            if (table === 'agents') {
              return Promise.resolve(
                Array.isArray(agents) ? { data: agents, error: null } : { data: null, error: agents.error }
              )
            }
            return Promise.resolve({ data: [], error: null })
          },
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

  it('never returns posted_by_org_id — only the derived is_demo/funding_status are public', async () => {
    const db = makeFakeDb([{ id: 'org-1', is_platform_seed: false }], [])
    const result = await attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: 'org-1', title: 'x' } as any])
    expect(result[0]).not.toHaveProperty('posted_by_org_id')
  })

  it('masks assigned_agent_id when its agent row is missing or visibility is unknown', async () => {
    const task = { id: 't1', assigned_agent_id: 'agent-1' }
    const missing = await attachPublicTaskFields(makeFakeDb([], [], []), [task])
    const unknown = await attachPublicTaskFields(
      makeFakeDb([], [], [{ id: 'agent-1', profile_visibility: 'future-mode' }]),
      [task],
      { role: 'buyer', task_id: 't1' }
    )
    expect(missing[0].assigned_agent_id).toBeNull()
    expect(unknown[0].assigned_agent_id).toBeNull()
  })

  it('reveals a private assigned_agent_id only to the agent itself or an admin, never the buyer', async () => {
    const task = { id: 't1', assigned_agent_id: 'agent-1' }
    const agents = [{ id: 'agent-1', profile_visibility: 'private' }]
    expect((await attachPublicTaskFields(makeFakeDb([], [], agents), [task], { agent_id: 'agent-1' }))[0].assigned_agent_id).toBe('agent-1')
    expect((await attachPublicTaskFields(makeFakeDb([], [], agents), [task], { tier: 'admin' }))[0].assigned_agent_id).toBe('agent-1')
    expect((await attachPublicTaskFields(makeFakeDb([], [], agents), [task], { role: 'buyer', task_id: 't1' }))[0].assigned_agent_id).toBeNull()
  })

  it('queries organizations and transactions exactly once each for a whole page of tasks — no N+1', async () => {
    const db = makeFakeDb([{ id: 'org-1', is_platform_seed: false }], [])
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, posted_by_org_id: 'org-1' }))
    await attachPublicTaskFields(db, tasks)
    expect(db._calls.filter((t: string) => t === 'organizations')).toHaveLength(1)
    expect(db._calls.filter((t: string) => t === 'transactions')).toHaveLength(1)
  })

  it('throws when the organizations lookup errors — never silently treats a failed lookup as "no seed orgs"', async () => {
    const db = makeFakeDb({ error: new Error('org lookup failed') }, [])
    await expect(
      attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: 'org-1' }])
    ).rejects.toThrow('org lookup failed')
  })

  it('throws when the transactions lookup errors', async () => {
    const db = makeFakeDb([], { error: new Error('tx lookup failed') })
    await expect(
      attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: 'org-1' }])
    ).rejects.toThrow('tx lookup failed')
  })

  describe('funding_status is derived from the most recent payment attempt, not the "furthest along" one', () => {
    it('an older refunded attempt followed by a newer held one resolves to funded', async () => {
      const db = makeFakeDb([], [
        { id: 'tx-1', task_id: 't1', escrow_status: 'refunded', created_at: '2026-08-01T00:00:00.000Z' },
        { id: 'tx-2', task_id: 't1', escrow_status: 'held', created_at: '2026-08-02T00:00:00.000Z' },
      ])
      const result = await attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: undefined }])
      expect(result[0].funding_status).toBe('funded')
    })

    it('an older refunded attempt followed by a newer pending one resolves to funding_pending', async () => {
      const db = makeFakeDb([], [
        { id: 'tx-1', task_id: 't1', escrow_status: 'refunded', created_at: '2026-08-01T00:00:00.000Z' },
        { id: 'tx-2', task_id: 't1', escrow_status: 'pending', created_at: '2026-08-02T00:00:00.000Z' },
      ])
      const result = await attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: undefined }])
      expect(result[0].funding_status).toBe('funding_pending')
    })

    it('an older failed attempt followed by a newer held one resolves to funded', async () => {
      const db = makeFakeDb([], [
        { id: 'tx-1', task_id: 't1', escrow_status: 'failed', created_at: '2026-08-01T00:00:00.000Z' },
        { id: 'tx-2', task_id: 't1', escrow_status: 'held', created_at: '2026-08-02T00:00:00.000Z' },
      ])
      const result = await attachPublicTaskFields(db, [{ id: 't1', posted_by_org_id: undefined }])
      expect(result[0].funding_status).toBe('funded')
    })

    it('the result does not depend on what order the database returns the rows in', async () => {
      const rows = [
        { id: 'tx-1', task_id: 't1', escrow_status: 'refunded', created_at: '2026-08-01T00:00:00.000Z' },
        { id: 'tx-2', task_id: 't1', escrow_status: 'held', created_at: '2026-08-02T00:00:00.000Z' },
      ]
      const forward = await attachPublicTaskFields(makeFakeDb([], rows), [{ id: 't1', posted_by_org_id: undefined }])
      const reversed = await attachPublicTaskFields(makeFakeDb([], [...rows].reverse()), [{ id: 't1', posted_by_org_id: undefined }])
      expect(forward[0].funding_status).toBe('funded')
      expect(reversed[0].funding_status).toBe('funded')
    })

    it('a tied created_at breaks deterministically by id, not by array order', async () => {
      const rows = [
        { id: 'tx-aaa', task_id: 't1', escrow_status: 'refunded', created_at: '2026-08-01T00:00:00.000Z' },
        { id: 'tx-bbb', task_id: 't1', escrow_status: 'held', created_at: '2026-08-01T00:00:00.000Z' },
      ]
      const forward = await attachPublicTaskFields(makeFakeDb([], rows), [{ id: 't1', posted_by_org_id: undefined }])
      const reversed = await attachPublicTaskFields(makeFakeDb([], [...rows].reverse()), [{ id: 't1', posted_by_org_id: undefined }])
      expect(forward[0].funding_status).toBe(reversed[0].funding_status)
    })
  })
})

describe('computeSettledMetrics', () => {
  function makeSettledFakeDb(
    transactions: { task_id: string; gross_amount_eur: number; released_at: string }[] | { error: unknown },
    tasks: { id: string; posted_by_org_id: string }[] | { error: unknown },
    orgs: { id: string; is_platform_seed: boolean }[] | { error: unknown }
  ) {
    return {
      from(table: string) {
        if (table === 'transactions') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: (from: number, to: number) =>
                    Promise.resolve(
                      Array.isArray(transactions)
                        ? { data: transactions.slice(from, to + 1), error: null }
                        : { data: null, error: transactions.error }
                    ),
                }),
              }),
            }),
          }
        }
        const source = table === 'tasks' ? tasks : orgs
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve(
                Array.isArray(source)
                  ? { data: source.filter((r: any) => ids.includes(r.id)), error: null }
                  : { data: null, error: source.error }
              ),
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

  it('paginates past 1000 released transactions rather than silently capping the count', async () => {
    const bigSet = Array.from({ length: 1500 }, (_, i) => ({
      task_id: `task-${i}`,
      gross_amount_eur: 10,
      released_at: new Date(2026, 7, 1, 0, 0, i).toISOString(),
    }))
    const tasks = bigSet.map((tx) => ({ id: tx.task_id, posted_by_org_id: 'org-real' }))
    const orgs = [{ id: 'org-real', is_platform_seed: false }]
    const db = makeSettledFakeDb(bigSet, tasks, orgs)
    const result = await computeSettledMetrics(db)
    expect(result.tasksCompleted).toBe(1500)
    expect(result.gmvEur).toBe(15000)
  })

  it('a released transaction for a task that cannot be found is excluded, not counted as real', async () => {
    // The transactions query itself succeeds, but the task lookup finds no
    // matching row — e.g. orphaned data. Its organization can never be
    // verified, so it must never contribute to GMV.
    const db = makeSettledFakeDb(
      [{ task_id: 'orphan-1', gross_amount_eur: 500, released_at: '2026-08-01T00:00:00Z' }],
      [], // tasks lookup succeeds but finds nothing
      []
    )
    const result = await computeSettledMetrics(db)
    expect(result).toEqual({ tasksCompleted: 0, gmvEur: 0 })
  })

  it('rounds the summed GMV to whole cents, avoiding floating-point drift', async () => {
    const db = makeSettledFakeDb(
      [
        { task_id: 't1', gross_amount_eur: 0.1, released_at: '2026-08-01T00:00:00Z' },
        { task_id: 't2', gross_amount_eur: 0.2, released_at: '2026-08-02T00:00:00Z' },
      ],
      [
        { id: 't1', posted_by_org_id: 'org-real' },
        { id: 't2', posted_by_org_id: 'org-real' },
      ],
      [{ id: 'org-real', is_platform_seed: false }]
    )
    const result = await computeSettledMetrics(db)
    expect(result.gmvEur).toBe(0.3)
  })

  it('throws when the organizations lookup errors — a failed org check must never let demo GMV count as real', async () => {
    const db = makeSettledFakeDb(
      [{ task_id: 't1', gross_amount_eur: 100, released_at: '2026-08-01T00:00:00Z' }],
      [{ id: 't1', posted_by_org_id: 'org-1' }],
      { error: new Error('org lookup failed') }
    )
    await expect(computeSettledMetrics(db)).rejects.toThrow('org lookup failed')
  })

  it('throws when the tasks lookup errors — must never let an unverifiable transaction count', async () => {
    const db = makeSettledFakeDb(
      [{ task_id: 't1', gross_amount_eur: 100, released_at: '2026-08-01T00:00:00Z' }],
      { error: new Error('task lookup failed') },
      []
    )
    await expect(computeSettledMetrics(db)).rejects.toThrow('task lookup failed')
  })

  it('throws when the transactions page query itself errors', async () => {
    const db = makeSettledFakeDb({ error: new Error('tx query failed') }, [], [])
    await expect(computeSettledMetrics(db)).rejects.toThrow('tx query failed')
  })
})
