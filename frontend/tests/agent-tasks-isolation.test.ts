import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-agent-tasks-isolation-32ch'

const AGENT_ID = 'agent-with-history'
const OTHER_AGENT_ID = 'agent-other'

const rawTask = {
  id: 'task-1',
  title: 'Analyse a dataset',
  description: 'Produce a decision-ready report.',
  category: 'data_analysis',
  budget_min_eur: 100,
  budget_max_eur: 200,
  deadline_hours: 48,
  status: 'completed',
  assigned_agent_id: AGENT_ID,
  created_at: '2026-08-01T00:00:00.000Z',
  assigned_at: '2026-08-01T01:00:00.000Z',
  delivery_deadline_at: '2026-08-03T00:00:00.000Z',
  moderation_status: 'approved',
  // Must never leak through this public, unauthenticated endpoint.
  buyer_email: 'buyer@example.com',
  buyer_token: 'buyer-token-private',
  delivery_note: 'Private delivered work',
  dispute_reason: 'Private buyer message',
  posted_by_org_id: 'org-real',
  embedding: [0.1, 0.2],
  moderation_risk_score: 0,
  moderation_reason_codes: [],
  moderated_by: 'system:auto',
}

let selectedColumns = ''
let agentProfileVisibility = 'public'
let seedOrgRows: { id: string; is_platform_seed: boolean }[] = []
let transactionRows: { id: string; task_id: string; escrow_status: string; created_at: string }[] = []
let bidsQueryCount = 0

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const inFilters: [string, unknown[]][] = []
      if (table === 'bids') bidsQueryCount += 1
      const builder: Record<string, any> = {
        select(columns: string) {
          if (table === 'tasks') selectedColumns = columns
          return builder
        },
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        in: (field: string, values: unknown[]) => { inFilters.push([field, values]); return builder },
        order: () => builder,
        limit: () => builder,
        // fetchAgentVisibilityRow's single lookup, keyed by params.id.
        single: async () => (table === 'agents' ? { data: { id: AGENT_ID, profile_visibility: agentProfileVisibility }, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'tasks') {
            const matches = eqFilters.every(([f, v]) => (rawTask as Record<string, unknown>)[f] === v)
            return resolve({ data: matches ? [rawTask] : [], error: null })
          }
          if (table === 'agents') {
            // fetchAgentVisibilityRows' batch lookup (used inside
            // attachPublicTaskFields) — this suite only ever has one real
            // agent identity in play, AGENT_ID, regardless of which ids
            // were actually requested via .in(...).
            return resolve({ data: [{ id: AGENT_ID, profile_visibility: agentProfileVisibility }], error: null })
          }
          if (table === 'organizations') return resolve({ data: seedOrgRows, error: null })
          if (table === 'transactions') return resolve({ data: transactionRows, error: null })
          if (table === 'bids') return resolve({ data: [], error: null })
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
  }),
}))

describe('GET /api/v1/agents/[id]/tasks', () => {
  it('returns only public fields for an approved task, filtered to that agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
    const response = await GET(request, { params: { id: AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.tasks).toHaveLength(1)
    expect(selectedColumns).not.toBe('*')

    for (const privateField of [
      'buyer_email', 'buyer_token', 'delivery_note', 'dispute_reason',
      'embedding', 'moderation_risk_score', 'moderation_reason_codes', 'moderated_by',
    ]) {
      expect(body.tasks[0]).not.toHaveProperty(privateField)
      expect(selectedColumns.split(',')).not.toContain(privateField)
    }
    // posted_by_org_id IS legitimately in the select now (needed to derive
    // is_demo, same as GET /tasks and GET /tasks/[id]) — the guarantee that
    // matters is it never reaches the response body, already checked above.
    expect(body.tasks[0]).not.toHaveProperty('posted_by_org_id')
  })

  it('includes is_demo and funding_status, derived the same way as GET /tasks/[id]', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
    const response = await GET(request, { params: { id: AGENT_ID } })
    const body = await response.json()
    expect(body.tasks[0]).toMatchObject({ is_demo: false, funding_status: 'unfunded' })
  })

  it('marks a task from the platform seed organization as is_demo', async () => {
    seedOrgRows = [{ id: 'org-real', is_platform_seed: true }]
    try {
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
      const response = await GET(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(body.tasks[0].is_demo).toBe(true)
      // A demo task's execution_authorized/next_action must always be
      // ignore_demo/false, even though status here is 'completed' anyway.
      expect(body.tasks[0]).toMatchObject({ execution_authorized: false, next_action: 'ignore_demo' })
    } finally {
      seedOrgRows = []
    }
  })

  it('excludes a task that is not approved — same filter GET /tasks/[id] applies', async () => {
    const original = rawTask.moderation_status
    ;(rawTask as any).moderation_status = 'quarantined'
    try {
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
      const response = await GET(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.tasks).toEqual([])
    } finally {
      ;(rawTask as any).moderation_status = original
    }
  })

  it('404s a private agent\'s work history for an anonymous caller', async () => {
    agentProfileVisibility = 'private'
    try {
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
      const response = await GET(request, { params: { id: AGENT_ID } })
      expect(response.status).toBe(404)
    } finally {
      agentProfileVisibility = 'public'
    }
  })
})

describe('GET /api/v1/agents/[id]/tasks — execution_authorized (in_progress + funded)', () => {
  it('grants execution_authorized=true to the truly assigned agent once in_progress and funded', async () => {
    const original = rawTask.status
    ;(rawTask as any).status = 'in_progress'
    transactionRows = [{ id: 'tx-1', task_id: 'task-1', escrow_status: 'held', created_at: '2026-08-01T02:00:00.000Z' }]
    try {
      const ownToken = await signToken({ agent_id: AGENT_ID, tier: 1 }, '15m')
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`, { headers: { authorization: `Bearer ${ownToken}` } })
      const response = await GET(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(body.tasks[0]).toMatchObject({ funding_status: 'funded', execution_authorized: true, next_action: 'perform_and_deliver' })
    } finally {
      ;(rawTask as any).status = original
      transactionRows = []
    }
  })

  it('never grants execution_authorized=true to an anonymous caller, even for the same in_progress+funded task', async () => {
    const original = rawTask.status
    ;(rawTask as any).status = 'in_progress'
    transactionRows = [{ id: 'tx-1', task_id: 'task-1', escrow_status: 'held', created_at: '2026-08-01T02:00:00.000Z' }]
    try {
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
      const response = await GET(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(body.tasks[0]).toMatchObject({ execution_authorized: false, next_action: 'closed' })
    } finally {
      ;(rawTask as any).status = original
      transactionRows = []
    }
  })

  it('never grants execution_authorized=true to a different agent\'s own token', async () => {
    const original = rawTask.status
    ;(rawTask as any).status = 'in_progress'
    transactionRows = [{ id: 'tx-1', task_id: 'task-1', escrow_status: 'held', created_at: '2026-08-01T02:00:00.000Z' }]
    try {
      const otherToken = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`, { headers: { authorization: `Bearer ${otherToken}` } })
      const response = await GET(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(body.tasks[0]).toMatchObject({ execution_authorized: false, next_action: 'closed' })
    } finally {
      ;(rawTask as any).status = original
      transactionRows = []
    }
  })
})

describe('GET /api/v1/agents/[id]/tasks — no N+1', () => {
  it('queries the bids table at most once per request, never once per task', async () => {
    bidsQueryCount = 0
    const ownToken = await signToken({ agent_id: AGENT_ID, tier: 1 }, '15m')
    const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`, { headers: { authorization: `Bearer ${ownToken}` } })
    await GET(request, { params: { id: AGENT_ID } })
    // This fixture only ever has one task, so the meaningful assertion is
    // that fetchAgentBidTaskIds's own batching (a single .in(...) call for
    // however many task ids are on the page) is what the route actually
    // calls — see frontend/tests/execution-authorization.test.ts for the
    // dedicated many-tasks-one-query proof of that helper itself.
    expect(bidsQueryCount).toBeLessThanOrEqual(1)
  })
})
