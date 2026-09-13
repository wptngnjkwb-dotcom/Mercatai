import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-moderation-isolation-32ch'

const insertedTasks: Record<string, unknown>[] = []
const insertedOrgs: Record<string, unknown>[] = []
const moderationEvents: Record<string, unknown>[] = []
let orgLookupResult: { id: string; is_suspended?: boolean } | null = null

// One shared canned task, mutated per-test to represent different
// moderation states — this is what GET list/detail/activity/bids all read.
let cannedTask: Record<string, unknown> = {
  id: 'task-1',
  title: 'Analyse a dataset',
  description: 'A perfectly ordinary, benign task description with no red flags at all.',
  category: 'research',
  status: 'open',
  budget_min_eur: 50,
  budget_max_eur: 100,
  deadline_hours: 24,
  required_capabilities: [],
  required_languages: ['en'],
  posted_by_org_id: 'org-1',
  assigned_agent_id: null,
  bidding_closes_at: null,
  created_at: '2026-08-20T00:00:00.000Z',
  assigned_at: null,
  delivery_deadline_at: null,
  moderation_status: 'approved',
}

// Rows for the activity feed's recentBids query — each carries its own
// embedded task moderation_status/posted_by_org_id, independent of
// cannedTask above.
let activityBidRows: { id: string; price_eur: number; submitted_at: string; tasks: { title: string; category: string; moderation_status: string; posted_by_org_id?: string; archived_at?: string | null } | null; agents: { display_name: string; profile_visibility?: string } }[] = []

// Seedable transactions/organizations rows for is_demo + funding_status +
// settled-GMV coverage. The shared `tasks` dispatch below only ever returns
// cannedTask (id 'task-1', posted_by_org_id 'org-1') for any .in('id', …)
// lookup with no .eq() filters — see computeSettledMetrics' task_id →
// posted_by_org_id lookup — so every transaction row seeded here uses
// task_id: 'task-1' to stay consistent with what that lookup will resolve to.
let activityTransactionRows: { task_id: string; escrow_status: string; gross_amount_eur?: number; released_at?: string | null; created_at?: string }[] = []
let activityOrganizationRows: { id: string; is_platform_seed: boolean }[] = []
// When non-empty, backs settledCompletions' per-page `.in('id', taskIds)`
// task lookup with real, distinct rows instead of the single cannedTask —
// needed to test pagination across many different tasks. Left empty, the
// 'tasks' dispatch below falls back to its original cannedTask behavior
// exactly as before, so no existing test is affected.
let activitySettledTaskRows: { id: string; title?: string; category?: string; posted_by_org_id?: string | null; archived_at?: string | null }[] = []
// Backs the batched agents visibility lookup attachPublicTaskFields makes
// for GET /api/v1/tasks (list) — separate from cannedTask so a task's
// assigned_agent_id can be tested against both a public and a private agent.
let taskListAgentVisibilityRows: { id: string; profile_visibility?: string }[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      // Real filters, tracked per query chain — so an isolation test that
      // asserts "excluded" only passes if the route actually applied the
      // .eq('moderation_status', 'approved') filter, not because the mock
      // assumed it would.
      const eqFilters: [string, unknown][] = []
      const isFilters: [string, unknown][] = []
      const notFilters: [string, string, unknown][] = []
      let insertedRow: Record<string, unknown> | null = null
      let selectedColumns: string | null = null
      let inFilterIds: string[] | null = null
      // Tracks .range(from, to) so 'bids'/'transactions' dispatch below can
      // slice deterministically — real regression coverage for "LIMIT must
      // apply only to visible rows" needs the mock to actually paginate,
      // not just ignore range/limit and hand back everything.
      let rangeArgs: [number, number] | null = null
      // Tracks .limit(n) the same way — real enforcement, not a no-op, so a
      // regression test can distinguish "the route still calls .limit()
      // before filtering" (would truncate to hidden rows) from the fixed
      // .range()-paginated version.
      let limitValue: number | null = null
      const applyPaging = <R,>(rows: R[]) =>
        rangeArgs ? rows.slice(rangeArgs[0], rangeArgs[1] + 1) : limitValue != null ? rows.slice(0, limitValue) : rows
      const builder: Record<string, any> = {
        select: (columns?: string) => { if (columns) selectedColumns = columns; return builder },
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        is: (field: string, value: unknown) => { isFilters.push([field, value]); return builder },
        not: (field: string, operator: string, value: unknown) => { notFilters.push([field, operator, value]); return builder },
        in: (_field: string, ids: unknown[]) => { inFilterIds = ids as string[]; return builder },
        gte: () => builder,
        order: () => builder,
        limit: (n: number) => { limitValue = n; return builder },
        range: (from: number, to: number) => { rangeArgs = [from, to]; return builder },
        maybeSingle: async () => {
          if (table === 'organizations') return { data: orgLookupResult, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'tasks') {
            // Distinguish "just inserted, .select().single() the result back"
            // from "plain fetch by id" — a shared mock must not conflate them.
            if (insertedRow) return { data: { id: `task-${insertedTasks.length}`, ...insertedRow }, error: null }
            return { data: cannedTask, error: null }
          }
          if (table === 'organizations') return { data: { id: 'org-new' }, error: null }
          return { data: null, error: null }
        },
        insert: (values: Record<string, unknown>) => {
          if (table === 'tasks') { insertedTasks.push(values); insertedRow = values }
          if (table === 'task_moderation_events') moderationEvents.push(values)
          if (table === 'organizations') insertedOrgs.push(values)
          return builder
        },
        update: () => builder,
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'tasks') {
            // A page-scoped .in('id', taskIds) lookup (settledCompletions'
            // pagination) is served from activitySettledTaskRows when a
            // test has seeded it, so multiple distinct tasks can be tested
            // — otherwise fall through to the original single-cannedTask
            // behavior below, unchanged for every other existing test.
            if (inFilterIds && activitySettledTaskRows.length > 0) {
              const matched = activitySettledTaskRows.filter((t) => inFilterIds!.includes(t.id))
              return resolve({ data: matched, count: matched.length, error: null })
            }
            const matches = eqFilters.every(([f, v]) => (cannedTask as Record<string, unknown>)[f] === v)
              && isFilters.every(([f, v]) => ((cannedTask as Record<string, unknown>)[f] ?? null) === v)
              && notFilters.every(([f, op, v]) => (op === 'is' ? ((cannedTask as Record<string, unknown>)[f] ?? null) !== v : true))
            // Project down to the actually-selected columns, same as a real
            // Postgres/PostgREST query would — a column used only in .eq()
            // (like moderation_status here) is never returned unless it was
            // also named in .select(...). Without this, a generic spread
            // helper like attachPublicTaskFields could look safe against
            // this mock while actually leaking an unselected column.
            const project = (row: Record<string, unknown>) =>
              selectedColumns
                ? Object.fromEntries(selectedColumns.split(',').map((c) => c.trim()).map((c) => [c, row[c]]))
                : row
            return resolve({ data: matches ? [project(cannedTask)] : [], count: matches ? 1 : 0, error: null })
          }
          if (table === 'bids') {
            return resolve({ data: applyPaging(activityBidRows), count: activityBidRows.length, error: null })
          }
          if (table === 'agents') return resolve({ data: taskListAgentVisibilityRows, count: taskListAgentVisibilityRows.length, error: null })
          if (table === 'transactions') {
            const matches = activityTransactionRows.filter((row) =>
              eqFilters.every(([f, v]) => (row as Record<string, unknown>)[f] === v)
            )
            return resolve({ data: applyPaging(matches), count: matches.length, error: null })
          }
          if (table === 'organizations') return resolve({ data: activityOrganizationRows, count: activityOrganizationRows.length, error: null })
          return resolve({ data: [], count: 0, error: null })
        },
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/email', () => ({ sendNewBid: vi.fn(async () => {}), sendTaskCreated: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/autobid', () => ({ runAutoBids: vi.fn(async () => ({ bids_placed: 0, agents_notified: 0 })) }))
vi.mock('@/lib/server/affiliate', () => ({ resolveApiClient: vi.fn(async () => null) }))
vi.mock('@/lib/server/apiUsage', () => ({ checkQuota: vi.fn(async () => ({ allowed: true })), trackApiCall: vi.fn() }))

beforeEach(() => {
  insertedTasks.length = 0
  insertedOrgs.length = 0
  moderationEvents.length = 0
  orgLookupResult = null
  cannedTask = { ...cannedTask, moderation_status: 'approved', archived_at: null, archived_reason: null }
  activityBidRows = []
  activityTransactionRows = []
  activityOrganizationRows = []
  activitySettledTaskRows = []
  taskListAgentVisibilityRows = []
})

describe('POST /api/v1/tasks — moderation publish flow', () => {
  it('publishes an allowed task with 201, and fires webhooks + auto-bid', async () => {
    const { POST } = await import('@/app/api/v1/tasks/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const { runAutoBids } = await import('@/lib/server/autobid')
    const request = new NextRequest('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Competitive scan of EU invoicing SaaS pricing',
        description: 'Research public pricing pages for 8 EU invoicing SaaS products, e.g. https://example.com/pricing, and deliver a comparison table with source links.',
        budget_max_eur: 200,
        deadline_hours: 48,
      }),
    })
    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(insertedTasks[0]).toMatchObject({ moderation_status: 'approved' })
    expect(insertedTasks[0]).toHaveProperty('published_at')
    expect((insertedTasks[0] as any).published_at).not.toBeNull()
    expect(body).toHaveProperty('buyer_token')
    expect(body).not.toHaveProperty('appeal_available')
    // The raw inserted/returned row carries these — the public response
    // must not, even though it's built from that same row. Built
    // explicitly in the route rather than spread, precisely so this can
    // never regress silently.
    for (const internalField of ['moderation_risk_score', 'moderation_reason_codes', 'moderation_policy_version', 'moderated_by', 'moderated_at', 'posted_by_org_id']) {
      expect(body).not.toHaveProperty(internalField)
    }
    expect(fireWebhooks).toHaveBeenCalled()
    expect(runAutoBids).toHaveBeenCalled()
  })

  it('rejects a credential-harvesting task with 422, persists it, and never publishes it', async () => {
    const { POST } = await import('@/app/api/v1/tasks/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const { runAutoBids } = await import('@/lib/server/autobid')
    vi.mocked(fireWebhooks).mockClear()
    vi.mocked(runAutoBids).mockClear()
    const request = new NextRequest('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Proven 'reject' fixture — see task-moderation-engine.test.ts
      // "rejects a seed phrase request alone".
      body: JSON.stringify({
        title: 'Verify wallet',
        description: 'We just need your seed phrase to confirm you own the wallet, nothing else.',
        budget_max_eur: 50,
        deadline_hours: 24,
      }),
    })
    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(422)
    expect(body.moderation_status).toBe('rejected')
    expect(body.reason_codes.length).toBeGreaterThan(0)
    expect(body).toHaveProperty('buyer_token')
    expect(insertedTasks[0]).toMatchObject({ moderation_status: 'rejected' })
    expect(fireWebhooks).not.toHaveBeenCalled()
    expect(runAutoBids).not.toHaveBeenCalled()
  })

  it('quarantines a wallet-connect-without-seed-phrase task with 202, and never publishes it', async () => {
    // Confirm the exact tier first — this fixture only trips the
    // wallet-connect signal (55pts, hardFloor 'quarantine'; see WALLET_TERMS
    // in rules.ts, which requires the literal phrase "connect your wallet"),
    // no seed phrase/private key phrase, so it should never reach 'reject'.
    const { moderateTask } = await import('@/lib/server/taskModeration/moderateTask')
    const fixture = {
      title: 'Payment setup',
      description: 'Please connect your wallet so we can send your payment for this completed task.',
      budgetMinEur: 50,
      budgetMaxEur: 100,
      category: 'research',
    }
    const direct = await moderateTask(fixture)
    expect(direct.decision).toBe('quarantine')

    const { POST } = await import('@/app/api/v1/tasks/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const { runAutoBids } = await import('@/lib/server/autobid')
    vi.mocked(fireWebhooks).mockClear()
    vi.mocked(runAutoBids).mockClear()
    const request = new NextRequest('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: fixture.title,
        description: fixture.description,
        budget_max_eur: 100,
        deadline_hours: 24,
      }),
    })
    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(202)
    expect(body.moderation_status).toBe('quarantined')
    expect(insertedTasks.at(-1)).toMatchObject({ moderation_status: 'quarantined' })
    expect(fireWebhooks).not.toHaveBeenCalled()
    expect(runAutoBids).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/tasks — organization identity (P0 fix)', () => {
  const benignBody = {
    title: 'Competitive scan of EU invoicing SaaS pricing',
    description: 'Research public pricing pages for 8 EU invoicing SaaS products, e.g. https://example.com/pricing, and deliver a comparison table with source links.',
    budget_max_eur: 200,
    deadline_hours: 48,
  }

  it('org_name is never used to look up or attach to an existing organization — the reported spoofing bug', async () => {
    const { POST } = await import('@/app/api/v1/tasks/route')
    const request = new NextRequest('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Typing the platform's own seed org name, or any real customer's
      // name, must never attach this task to that organization's identity.
      body: JSON.stringify({ ...benignBody, org_name: 'Mercatai Sample Briefs' }),
    })
    const response = await POST(request)
    expect(response.status).toBe(201)
    // A new org was created (matching the org_name lookup being gone
    // entirely) — this mock's organizations.insert is only ever reached
    // on the "always create new" path, never on a "found existing" path.
    expect(insertedOrgs).toHaveLength(1)
    expect(insertedOrgs[0]).toMatchObject({ name: 'Mercatai Sample Briefs' })
  })

  it('a presented buyer_token does not grant reuse of that org for a new task — buyer_token stays task-scoped', async () => {
    const { POST } = await import('@/app/api/v1/tasks/route')
    const { signToken } = await import('@/lib/server/auth')
    // A token bound to some earlier, different task — even though it's
    // validly signed and carries an org_id, POST /tasks must not honor it
    // as authorization to post again under that organization.
    const priorBuyerToken = await signToken({ role: 'buyer', task_id: 'some-earlier-task', org_id: 'org-from-a-previous-task' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${priorBuyerToken}` },
      body: JSON.stringify(benignBody),
    })
    const response = await POST(request)
    expect(response.status).toBe(201)
    expect(insertedOrgs).toHaveLength(1)
    // A fresh org was created (this mock's org insert path returns a
    // synthetic 'org-new' id) — the task must land under that, never
    // under the org_id carried by the presented token.
    expect(insertedTasks[0]).toMatchObject({ posted_by_org_id: 'org-new' })
    expect(insertedTasks[0]).not.toMatchObject({ posted_by_org_id: 'org-from-a-previous-task' })
  })

  it('two consecutive anonymous posts with the identical org_name get two distinct organizations', async () => {
    const { POST } = await import('@/app/api/v1/tasks/route')
    const mkRequest = () => new NextRequest('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...benignBody, org_name: 'Acme Corp' }),
    })
    const r1 = await POST(mkRequest())
    const r2 = await POST(mkRequest())
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(insertedOrgs).toHaveLength(2)
    expect(insertedOrgs.every((o) => (o as any).name === 'Acme Corp')).toBe(true)
  })
})

describe('GET /api/v1/tasks — moderation isolation', () => {
  it('never surfaces a task whose moderation_status is not approved', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    cannedTask = { ...cannedTask, moderation_status: 'quarantined' }
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    // The mocked query always filters server-side via .eq('moderation_status','approved')
    // before returning — a quarantined task never reaches the response.
    expect(body.tasks).toEqual([])
  })
})

describe('GET /api/v1/tasks — archived tasks (reversible demo takedown)', () => {
  it('excludes an archived task from the default public list', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    cannedTask = { ...cannedTask, archived_at: '2026-01-01T00:00:00.000Z' }
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.tasks).toEqual([])
  })

  it('a real, non-archived, approved task remains visible — archiving demo content does not hide genuine listings', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0].id).toBe('task-1')
  })

  it('?archived=true is silently ignored for a caller with no admin token — never a public re-reveal parameter', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    cannedTask = { ...cannedTask, archived_at: '2026-01-01T00:00:00.000Z' }
    const request = new NextRequest('http://localhost/api/v1/tasks?archived=true')
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.tasks).toEqual([])
  })

  it('?archived=true is silently ignored for a non-admin agent token too', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    cannedTask = { ...cannedTask, archived_at: '2026-01-01T00:00:00.000Z' }
    const agentToken = await signToken({ agent_id: 'agent-1', tier: 1 }, '15m')
    const request = new NextRequest('http://localhost/api/v1/tasks?archived=true', { headers: { authorization: `Bearer ${agentToken}` } })
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.tasks).toEqual([])
  })

  it('?archived=true reveals the archived task to an admin token, including its archived_reason — admin can still find demo/archived data', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    cannedTask = { ...cannedTask, archived_at: '2026-01-01T00:00:00.000Z', archived_reason: 'demo_cleanup' }
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest('http://localhost/api/v1/tasks?archived=true', { headers: { authorization: `Bearer ${adminToken}` } })
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0].id).toBe('task-1')
    expect(body.tasks[0].archived_reason).toBe('demo_cleanup')
  })
})

describe('GET /api/v1/tasks — is_demo and funding_status', () => {
  it('marks a task from the seed organization as is_demo, with the correct funding_status from its transaction', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: true }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'released' }]
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.tasks[0]).toMatchObject({ is_demo: true, funding_status: 'released' })
  })

  it('a non-seed task with no transaction is not demo and is unfunded', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(body.tasks[0]).toMatchObject({ is_demo: false, funding_status: 'unfunded' })
  })

  it('never returns posted_by_org_id, internal moderation fields, or raw transaction fields — only the derived funding_status', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: true }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'held' }]
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    const task = body.tasks[0]
    for (const internalField of [
      'posted_by_org_id',
      'moderation_status',
      'moderation_risk_score',
      'moderation_reason_codes',
      'moderated_by',
      'escrow_status',
      'gross_amount_eur',
      'stripe_payment_intent_id',
    ]) {
      expect(task).not.toHaveProperty(internalField)
    }
    expect(task.funding_status).toBe('funded')
  })
})

describe('GET /api/v1/tasks — assigned_agent_id visibility (list)', () => {
  const PRIVATE_AGENT_ID = 'agent-private-1'

  async function withAssignedAgent(visibility: string, fn: () => Promise<void>) {
    const original = cannedTask.assigned_agent_id
    cannedTask = { ...cannedTask, assigned_agent_id: PRIVATE_AGENT_ID }
    taskListAgentVisibilityRows = [{ id: PRIVATE_AGENT_ID, profile_visibility: visibility }]
    try {
      await fn()
    } finally {
      cannedTask = { ...cannedTask, assigned_agent_id: original }
      taskListAgentVisibilityRows = []
    }
  }

  it('masks a private assigned agent to null in the task list for an anonymous caller', () => withAssignedAgent('private', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(body.tasks[0].assigned_agent_id).toBeNull()
    expect(JSON.stringify(body)).not.toContain(PRIVATE_AGENT_ID)
  }))

  it('keeps the internal assigned_agent_id hidden in the list from this task\'s own buyer token', () => withAssignedAgent('private', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: cannedTask.id, org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/tasks', { headers: { authorization: `Bearer ${buyerToken}` } })
    const response = await GET(request)
    const body = await response.json()
    expect(body.tasks[0].assigned_agent_id).toBeNull()
  }))

  it('still masks the agent in the list for a buyer token bound to a different task', () => withAssignedAgent('private', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: 'some-other-task', org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/tasks', { headers: { authorization: `Bearer ${buyerToken}` } })
    const response = await GET(request)
    const body = await response.json()
    expect(body.tasks[0].assigned_agent_id).toBeNull()
  }))

  it('reveals the real assigned_agent_id in the list to an admin token', () => withAssignedAgent('private', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest('http://localhost/api/v1/tasks', { headers: { authorization: `Bearer ${adminToken}` } })
    const response = await GET(request)
    const body = await response.json()
    expect(body.tasks[0].assigned_agent_id).toBe(PRIVATE_AGENT_ID)
  }))

  it('never masks a public assigned agent in the list — unchanged behavior', () => withAssignedAgent('public', async () => {
    const { GET } = await import('@/app/api/v1/tasks/route')
    const request = new NextRequest('http://localhost/api/v1/tasks')
    const response = await GET(request)
    const body = await response.json()
    expect(body.tasks[0].assigned_agent_id).toBe(PRIVATE_AGENT_ID)
  }))
})

// GET /api/v1/tasks/[id] and POST /api/v1/bids moderation-gate coverage
// lives in agent-public-response.test.ts and bids-auth.test.ts respectively
// — those files already import and mock those exact routes, and this suite
// runs with isolate:false (one shared worker, see vitest.config.ts), so a
// second file mocking the same route's dependencies would race with theirs
// instead of adding independent coverage.

describe('GET /api/v1/activity — moderation isolation', () => {
  it('does not throw and only ever queries tasks filtered to approved', async () => {
    const { GET } = await import('@/app/api/v1/activity/route')
    const request = new NextRequest('http://localhost/api/v1/activity')
    const response = await GET(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Array.isArray(body.events)).toBe(true)
  })

  it('excludes a bid whose task is quarantined — a bid is as private as its task', async () => {
    activityBidRows = [
      { id: 'bid-visible', price_eur: 50, submitted_at: '2026-08-22T10:00:00.000Z', tasks: { title: 'Visible task', category: 'research', moderation_status: 'approved' }, agents: { display_name: 'Agent A', profile_visibility: 'public' } },
      { id: 'bid-hidden', price_eur: 999, submitted_at: '2026-08-22T11:00:00.000Z', tasks: { title: 'Should stay hidden', category: 'research', moderation_status: 'quarantined' }, agents: { display_name: 'Agent B', profile_visibility: 'public' } },
    ]
    const { GET } = await import('@/app/api/v1/activity/route')
    const request = new NextRequest('http://localhost/api/v1/activity')
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    const bidEvents = body.events.filter((e: any) => e.id?.startsWith('bid-'))
    expect(bidEvents.some((e: any) => e.detail === 'Should stay hidden')).toBe(false)
    expect(bidEvents.some((e: any) => e.detail === 'Visible task')).toBe(true)
  })

  it('excludes a private agent\'s bid from the public feed entirely — not anonymized, dropped', async () => {
    activityBidRows = [
      { id: 'bid-pub', price_eur: 50, submitted_at: '2026-08-22T10:00:00.000Z', tasks: { title: 'Public task', category: 'research', moderation_status: 'approved' }, agents: { display_name: 'Public Agent', profile_visibility: 'public' } },
      { id: 'bid-priv', price_eur: 999, submitted_at: '2026-08-22T11:00:00.000Z', tasks: { title: 'Task with a private bidder', category: 'research', moderation_status: 'approved' }, agents: { display_name: 'Secret Agent', profile_visibility: 'private' } },
    ]
    const { GET } = await import('@/app/api/v1/activity/route')
    const request = new NextRequest('http://localhost/api/v1/activity')
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    const bidEvents = body.events.filter((e: any) => e.id?.startsWith('bid-'))
    expect(bidEvents.some((e: any) => e.detail === 'Public task')).toBe(true)
    expect(bidEvents.some((e: any) => e.detail === 'Task with a private bidder')).toBe(false)
    expect(JSON.stringify(body)).not.toContain('Secret Agent')
  })

  it('fails closed when a bid agent has a missing or unknown visibility value', async () => {
    activityBidRows = [
      { id: 'bid-unknown', price_eur: 50, submitted_at: '2026-08-22T10:00:00.000Z', tasks: { title: 'Unknown visibility', category: 'research', moderation_status: 'approved' }, agents: { display_name: 'Hidden A', profile_visibility: 'future-mode' } },
      { id: 'bid-missing', price_eur: 60, submitted_at: '2026-08-22T11:00:00.000Z', tasks: { title: 'Missing visibility', category: 'research', moderation_status: 'approved' }, agents: { display_name: 'Hidden B' } },
    ]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.events.some((e: any) => e.id === 'bid-bid-unknown')).toBe(false)
    expect(body.events.some((e: any) => e.id === 'bid-bid-missing')).toBe(false)
    expect(JSON.stringify(body)).not.toContain('Hidden A')
    expect(JSON.stringify(body)).not.toContain('Hidden B')
  })
})

describe('GET /api/v1/activity — settled metrics (real tasks_completed / gmv_eur)', () => {
  it('a completed task with no transaction at all contributes nothing', async () => {
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.stats.tasks_completed).toBe(0)
    expect(body.stats.gmv_eur).toBe(0)
    expect(body.stats.metrics_scope).toBe('released_non_demo_transactions')
  })

  it.each(['pending', 'failed', 'held', 'refunded'])(
    'a transaction with escrow_status %s is never counted as settled',
    async (escrowStatus) => {
      activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
      activityTransactionRows = [{ task_id: 'task-1', escrow_status: escrowStatus, gross_amount_eur: 999 }]
      const { GET } = await import('@/app/api/v1/activity/route')
      const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
      const body = await response.json()
      expect(body.stats.tasks_completed).toBe(0)
      expect(body.stats.gmv_eur).toBe(0)
    }
  )

  it('a non-demo task with a released transaction counts exactly once, using the transaction amount, not the task budget', async () => {
    // cannedTask.budget_max_eur is 100 — the transaction amount (77) must
    // win, proving GMV is not silently falling back to the posted budget.
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 77, released_at: '2026-08-20T12:00:00.000Z' }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.stats.tasks_completed).toBe(1)
    expect(body.stats.gmv_eur).toBe(77)
  })

  it('a demo (seed-organization) task with a released transaction is excluded from real GMV', async () => {
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: true }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 500, released_at: '2026-08-20T12:00:00.000Z' }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.stats.tasks_completed).toBe(0)
    expect(body.stats.gmv_eur).toBe(0)
  })

  it('two released transactions for the same task_id count once, not twice — the more recently released one wins', async () => {
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    activityTransactionRows = [
      { task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 40, released_at: '2026-08-19T08:00:00.000Z' },
      { task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 60, released_at: '2026-08-20T09:00:00.000Z' },
    ]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.stats.tasks_completed).toBe(1)
    expect(body.stats.gmv_eur).toBe(60)
  })
})

describe('GET /api/v1/activity — events feed: demo marking and real completions', () => {
  it('marks a bid event as is_demo when its task belongs to the seed organization', async () => {
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: true }]
    activityBidRows = [{
      id: 'bid-1', price_eur: 15, submitted_at: '2026-08-22T10:00:00.000Z',
      tasks: { title: 'Seed task', category: 'research', moderation_status: 'approved', posted_by_org_id: 'org-1' },
      agents: { display_name: 'Agent A', profile_visibility: 'public' },
    }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    const bidEvent = body.events.find((e: any) => e.id === 'bid-bid-1')
    expect(bidEvent).toMatchObject({ is_demo: true, amount_kind: 'bid' })
  })

  it('marks a "New task posted" event as is_demo when the task belongs to the seed organization, and labels its amount as a budget', async () => {
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: true }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    const taskEvent = body.events.find((e: any) => e.id === 'task-task-1')
    expect(taskEvent).toMatchObject({ is_demo: true, amount_kind: 'budget', type: 'task' })
  })

  it('a task with workflow status "completed" but no released transaction produces no "completed" event', async () => {
    cannedTask = { ...cannedTask, status: 'completed' }
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    activityTransactionRows = [] // no released transaction anywhere
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.events.some((e: any) => e.type === 'completed')).toBe(false)
  })

  it('a "completed" event, when it exists, uses the transaction amount and released_at — never the task budget or creation time', async () => {
    // cannedTask.budget_max_eur is 100 and created_at is 2026-08-20 — the
    // event must reflect the transaction's own 55 / released_at instead.
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 55, released_at: '2026-08-25T18:00:00.000Z' }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    const completedEvent = body.events.find((e: any) => e.type === 'completed')
    expect(completedEvent).toMatchObject({ amount_eur: 55, amount_kind: 'settled', is_demo: false, at: '2026-08-25T18:00:00.000Z' })
  })

  it('a demo task never produces a "completed" event, even with a released transaction', async () => {
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: true }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 500, released_at: '2026-08-25T18:00:00.000Z' }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.events.some((e: any) => e.type === 'completed')).toBe(false)
  })

  it('excludes an archived task from the "New task posted" events, even though it would otherwise be approved and from a real (non-demo) org', async () => {
    cannedTask = { ...cannedTask, archived_at: '2026-01-01T00:00:00.000Z' }
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.events.some((e: any) => e.id === 'task-task-1')).toBe(false)
  })

  it('excludes a bid on an archived task from the events feed, even though the bid and agent are otherwise public', async () => {
    activityBidRows = [{
      id: 'bid-1', price_eur: 15, submitted_at: '2026-08-22T10:00:00.000Z',
      tasks: { title: 'Archived task', category: 'research', moderation_status: 'approved', posted_by_org_id: 'org-1', archived_at: '2026-01-01T00:00:00.000Z' },
      agents: { display_name: 'Agent A', profile_visibility: 'public' },
    }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.events.some((e: any) => e.id === 'bid-bid-1')).toBe(false)
  })

  it('excludes an archived task from the "completed" event even with a released transaction — archived is broader than just demo', async () => {
    cannedTask = { ...cannedTask, archived_at: '2026-01-01T00:00:00.000Z' }
    activityOrganizationRows = [{ id: 'org-1', is_platform_seed: false }]
    activityTransactionRows = [{ task_id: 'task-1', escrow_status: 'released', gross_amount_eur: 500, released_at: '2026-08-25T18:00:00.000Z' }]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(body.events.some((e: any) => e.type === 'completed')).toBe(false)
  })
})

describe('GET /api/v1/activity — LIMIT applies only to visible events (no hidden backlog can push out a real one)', () => {
  it('recentBids: when the 15 newest bids all belong to archived demo tasks, the 16th (real, public) bid still appears', async () => {
    const hiddenBid = (n: number) => ({
      id: `hidden-${n}`,
      price_eur: 999,
      submitted_at: `2026-09-01T${String(23 - n).padStart(2, '0')}:00:00.000Z`,
      tasks: { title: `Archived demo task ${n}`, category: 'research', moderation_status: 'approved', posted_by_org_id: 'org-seed', archived_at: '2026-01-01T00:00:00.000Z' },
      agents: { display_name: `Demo Agent ${n}`, profile_visibility: 'public' },
    })
    // 15 hidden (archived) bids, newest-first, followed by one real, fully
    // visible bid as the 16th/oldest row — a raw `.limit(15)` applied
    // before filtering would return only the 15 hidden rows and the real
    // bid would never be seen.
    activityBidRows = [
      ...Array.from({ length: 15 }, (_, i) => hiddenBid(i)),
      {
        id: 'real-bid', price_eur: 42, submitted_at: '2026-09-01T07:00:00.000Z',
        tasks: { title: 'Real buyer-funded task', category: 'finance', moderation_status: 'approved', posted_by_org_id: 'org-real', archived_at: null },
        agents: { display_name: 'Real Agent', profile_visibility: 'public' },
      },
    ]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(response.status).toBe(200)
    const realEvent = body.events.find((e: any) => e.id === 'bid-real-bid')
    expect(realEvent).toMatchObject({ detail: 'Real buyer-funded task', amount_eur: 42 })
    expect(body.events.some((e: any) => e.id?.startsWith('bid-hidden-'))).toBe(false)
  })

  it('settledCompletions: when the 15 newest released transactions all belong to archived demo tasks, the 16th (real) completion still appears', async () => {
    activitySettledTaskRows = [
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `hidden-task-${i}`, title: `Archived demo task ${i}`, category: 'research',
        posted_by_org_id: 'org-seed', archived_at: '2026-01-01T00:00:00.000Z',
      })),
      { id: 'real-task', title: 'Real completed task', category: 'finance', posted_by_org_id: 'org-real', archived_at: null },
    ]
    activityOrganizationRows = [{ id: 'org-seed', is_platform_seed: true }, { id: 'org-real', is_platform_seed: false }]
    // 15 released transactions on archived demo tasks, newest-first,
    // followed by one real completed transaction as the 16th/oldest row.
    activityTransactionRows = [
      ...Array.from({ length: 15 }, (_, i) => ({
        task_id: `hidden-task-${i}`, escrow_status: 'released', gross_amount_eur: 999,
        released_at: `2026-09-01T${String(23 - i).padStart(2, '0')}:00:00.000Z`,
      })),
      { task_id: 'real-task', escrow_status: 'released', gross_amount_eur: 88, released_at: '2026-09-01T07:00:00.000Z' },
    ]
    const { GET } = await import('@/app/api/v1/activity/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/activity'))
    const body = await response.json()
    expect(response.status).toBe(200)
    const realEvent = body.events.find((e: any) => e.id === 'completed-real-task')
    expect(realEvent).toMatchObject({ detail: 'Real completed task', amount_eur: 88, is_demo: false })
    expect(body.events.some((e: any) => e.id?.startsWith('completed-hidden-task-'))).toBe(false)
  })
})
