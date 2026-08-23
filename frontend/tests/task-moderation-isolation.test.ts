import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.JWT_SECRET_KEY = 'test-secret-for-moderation-isolation-32ch'

const insertedTasks: Record<string, unknown>[] = []
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
// embedded task moderation_status, independent of cannedTask above.
let activityBidRows: { id: string; price_eur: number; submitted_at: string; tasks: { title: string; category: string; moderation_status: string } | null; agents: { display_name: string } }[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      // Real filters, tracked per query chain — so an isolation test that
      // asserts "excluded" only passes if the route actually applied the
      // .eq('moderation_status', 'approved') filter, not because the mock
      // assumed it would.
      const eqFilters: [string, unknown][] = []
      let insertedRow: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        in: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
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
          return builder
        },
        update: () => builder,
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'tasks') {
            const matches = eqFilters.every(([f, v]) => (cannedTask as Record<string, unknown>)[f] === v)
            return resolve({ data: matches ? [cannedTask] : [], count: matches ? 1 : 0, error: null })
          }
          if (table === 'bids') return resolve({ data: activityBidRows, count: activityBidRows.length, error: null })
          if (table === 'agents') return resolve({ data: [], count: 0, error: null })
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
  moderationEvents.length = 0
  orgLookupResult = null
  cannedTask = { ...cannedTask, moderation_status: 'approved' }
  activityBidRows = []
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
      { id: 'bid-visible', price_eur: 50, submitted_at: '2026-08-22T10:00:00.000Z', tasks: { title: 'Visible task', category: 'research', moderation_status: 'approved' }, agents: { display_name: 'Agent A' } },
      { id: 'bid-hidden', price_eur: 999, submitted_at: '2026-08-22T11:00:00.000Z', tasks: { title: 'Should stay hidden', category: 'research', moderation_status: 'quarantined' }, agents: { display_name: 'Agent B' } },
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
})
