import { describe, expect, it, vi } from 'vitest'
import { computeVerifiedAgentStats } from '@/lib/server/verifiedAgentStats'

// verifiedAgentStats.ts says only the optional reviews lookup may degrade;
// every other outcome query "still fails closed". Nothing tested that, so a
// swallowed error on transactions/tasks/organizations would have shipped
// silently wrong (partial) public statistics. Also pins the tie-break for
// duplicate reviews with an identical timestamp.
type Row = Record<string, any>

function fakeDb(seed: Record<string, Row[]>, failingTables = new Set<string>()) {
  return { from: (table: string) => query(seed[table] ?? [], failingTables.has(table)) }
}

function query(rows: Row[], fails: boolean, eqs: Array<[string, unknown]> = [], ins: Array<[string, Set<unknown>]> = [], range?: [number, number]): any {
  const builder: any = {
    select: () => builder,
    order: () => builder,
    eq: (f: string, v: unknown) => query(rows, fails, [...eqs, [f, v]], ins, range),
    in: (f: string, v: unknown[]) => query(rows, fails, eqs, [...ins, [f, new Set(v)]], range),
    range: (a: number, b: number) => query(rows, fails, eqs, ins, [a, b]),
    then(resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) {
      if (fails) return Promise.resolve({ data: null, error: { code: 'XX000', message: 'simulated outage' } }).then(resolve, reject)
      const filtered = rows.filter(r => eqs.every(([f, v]) => r[f] === v) && ins.every(([f, v]) => v.has(r[f])))
      return Promise.resolve({ data: range ? filtered.slice(range[0], range[1] + 1) : filtered, error: null }).then(resolve, reject)
    },
  }
  return builder
}

const seed = {
  transactions: [
    { id: 'tx-1', task_id: 'paid', agent_id: 'agent-1', escrow_status: 'released', created_at: '2026-01-01', released_at: '2026-01-02' },
  ],
  tasks: [{ id: 'paid', category: 'research', posted_by_org_id: 'org', source: 'marketplace', archived_at: null }],
  organizations: [{ id: 'org', is_platform_seed: false }],
}

describe('computeVerifiedAgentStats — required data fails closed', () => {
  for (const table of ['transactions', 'tasks', 'organizations']) {
    it(`rejects instead of returning partial statistics when ${table} cannot be read`, async () => {
      await expect(computeVerifiedAgentStats(fakeDb(seed, new Set([table])), 'agent-1')).rejects.toBeDefined()
    })
  }

  it('degrades only the rating when reviews cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const stats = await computeVerifiedAgentStats(fakeDb(seed, new Set(['reviews'])), 'agent-1')
      expect(stats.paid_tasks_completed).toBe(1)
      expect(stats.ratings_available).toBe(false)
      expect(log).toHaveBeenCalledWith('Verified agent rating data is unavailable')
      expect(JSON.stringify(log.mock.calls)).not.toContain('simulated outage')
    } finally {
      log.mockRestore()
    }
  })
})

describe('computeVerifiedAgentStats — duplicate reviews with the same timestamp', () => {
  const a = { id: 'a-review', task_id: 'paid', agent_id: 'agent-1', rating: 1, created_at: '2026-01-05' }
  const b = { id: 'b-review', task_id: 'paid', agent_id: 'agent-1', rating: 5, created_at: '2026-01-05' }

  it('keeps the same review whatever order the rows arrive in', async () => {
    const forward = await computeVerifiedAgentStats(fakeDb({ ...seed, reviews: [a, b] }), 'agent-1')
    const reversed = await computeVerifiedAgentStats(fakeDb({ ...seed, reviews: [b, a] }), 'agent-1')
    expect(forward.rated_tasks).toBe(1)
    expect(forward.average_rating).toBe(reversed.average_rating)
    expect(forward.average_rating).toBe(5)
  })
})
