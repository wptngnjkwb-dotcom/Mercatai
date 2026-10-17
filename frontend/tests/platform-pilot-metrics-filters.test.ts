import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// stats.platform_pilots is a public money figure. The existing activity test
// only runs one happy-path task, so removing any single filter in
// computePlatformPilotMetrics (source, status, visibility, moderation,
// archive, released transaction, once-per-task) left the suite green. Each
// row below violates exactly one of those conditions.
type Row = Record<string, any>
const state = vi.hoisted(() => ({ seed: {} as Record<string, any[]> }))

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      const ins: Array<[string, Set<unknown>]> = []
      const nulls: Array<[string, unknown]> = []
      const notNulls: string[] = []
      let head = false
      let order: [string, boolean] | undefined
      let range: [number, number] | undefined
      let limit: number | undefined
      const b: any = {
        select: (_cols?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return b },
        eq: (f: string, v: unknown) => { eqs.push([f, v]); return b },
        is: (f: string, v: unknown) => { nulls.push([f, v]); return b },
        not: (f: string, op: string, v: unknown) => { if (op === 'is' && v === null) notNulls.push(f); return b },
        in: (f: string, vals: unknown[]) => { ins.push([f, new Set(vals)]); return b },
        order: (f: string, o?: { ascending?: boolean }) => { order = [f, o?.ascending !== false]; return b },
        range: (a: number, c: number) => { range = [a, c]; return b },
        limit: (n: number) => { limit = n; return b },
        gte: () => b, lt: () => b, or: () => b,
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then(resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) {
          const rows = run()
          const result = head ? { data: null, count: rows.length, error: null } : { data: rows, count: rows.length, error: null }
          return Promise.resolve(result).then(resolve, reject)
        },
      }
      function run(): Row[] {
        let rows = (state.seed[table] ?? []).filter(r =>
          eqs.every(([f, v]) => f.includes('.') || r[f] === v)
          && ins.every(([f, v]) => v.has(r[f]))
          && nulls.every(([f, v]) => f.includes('.') || (v === null ? r[f] == null : r[f] === v))
          && notNulls.every(f => r[f] != null)
        )
        if (order) {
          const [f, asc] = order
          rows = [...rows].sort((x, y) => (String(x[f] ?? '') < String(y[f] ?? '') ? -1 : String(x[f] ?? '') > String(y[f] ?? '') ? 1 : 0) * (asc ? 1 : -1))
        }
        if (range) rows = rows.slice(range[0], range[1] + 1)
        if (limit !== undefined) rows = rows.slice(0, limit)
        return rows
      }
      return b
    },
  }),
}))

const base = { posted_by_org_id: 'org', category: 'research', budget_max_eur: 3, created_at: '2026-01-01T00:00:00Z', archived_reason: null }
const pilot = { ...base, source: 'internal_pilot', status: 'completed', visibility: 'public', moderation_status: 'approved', archived_at: null }

describe('GET /api/v1/activity — platform_pilots only counts released, public, completed, approved, non-archived internal pilots, once per task', () => {
  it('applies every qualifying condition and keeps marketplace figures separate', async () => {
    state.seed = {
      organizations: [{ id: 'org', is_platform_seed: false }],
      tasks: [
        { ...pilot, id: 't-pilot-done', title: 'a' },
        { ...pilot, id: 't-pilot-retried', title: 'b' },
        { ...pilot, id: 't-pilot-open', title: 'c', status: 'in_progress' },
        { ...pilot, id: 't-pilot-private', title: 'd', visibility: 'private' },
        { ...pilot, id: 't-pilot-archived', title: 'e', archived_at: '2026-02-01T00:00:00Z' },
        { ...pilot, id: 't-pilot-quarantined', title: 'f', moderation_status: 'quarantined' },
        { ...pilot, id: 't-pilot-refunded', title: 'g' },
        { ...base, id: 't-market', title: 'h', source: 'marketplace', status: 'completed', visibility: 'public', moderation_status: 'approved', archived_at: null },
      ],
      transactions: [
        { id: 'tx-01', task_id: 't-pilot-done', escrow_status: 'released', gross_amount_eur: 3, released_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-02', task_id: 't-pilot-retried', escrow_status: 'released', gross_amount_eur: 3, released_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
        { id: 'tx-03', task_id: 't-pilot-retried', escrow_status: 'released', gross_amount_eur: 5, released_at: '2026-01-05T00:00:00Z', created_at: '2026-01-04T00:00:00Z' },
        { id: 'tx-04', task_id: 't-pilot-open', escrow_status: 'released', gross_amount_eur: 7, released_at: '2026-01-06T00:00:00Z', created_at: '2026-01-05T00:00:00Z' },
        { id: 'tx-05', task_id: 't-pilot-private', escrow_status: 'released', gross_amount_eur: 11, released_at: '2026-01-06T00:00:00Z', created_at: '2026-01-05T00:00:00Z' },
        { id: 'tx-06', task_id: 't-pilot-archived', escrow_status: 'released', gross_amount_eur: 13, released_at: '2026-01-06T00:00:00Z', created_at: '2026-01-05T00:00:00Z' },
        { id: 'tx-07', task_id: 't-pilot-quarantined', escrow_status: 'released', gross_amount_eur: 17, released_at: '2026-01-06T00:00:00Z', created_at: '2026-01-05T00:00:00Z' },
        { id: 'tx-08', task_id: 't-pilot-refunded', escrow_status: 'refunded', gross_amount_eur: 19, released_at: null, created_at: '2026-01-05T00:00:00Z' },
        { id: 'tx-09', task_id: 't-market', escrow_status: 'released', gross_amount_eur: 100, released_at: '2026-01-07T00:00:00Z', created_at: '2026-01-06T00:00:00Z' },
      ],
    }

    const { GET } = await import('@/app/api/v1/activity/route')
    const body = await (await GET(new NextRequest('http://localhost/api/v1/activity'))).json()

    // Newest released row per task: 3 (done) + 5 (retried) = 8 across 2 tasks.
    expect(body.stats.platform_pilots).toEqual({
      tasks_completed: 2,
      value_eur: 8,
      metrics_scope: 'released_public_internal_pilot_transactions',
    })
    // Marketplace figures contain only the marketplace task, never a pilot.
    expect(body.stats.tasks_completed).toBe(1)
    expect(body.stats.gmv_eur).toBe(100)
  })
})
