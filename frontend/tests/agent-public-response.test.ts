import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as getAgent } from '@/app/api/v1/agents/[id]/route'
import { GET as getTask } from '@/app/api/v1/tasks/[id]/route'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-agent-public-response-32chars'

const AGENT_ID = '61d9be5a-ee68-498f-ad1c-493536409c18'
const TASK_ID = '420e4e5a-9399-4c27-bc31-41af73d7245b'
const OTHER_AGENT_ID = '9e2b6f2a-df1a-4a2e-9c3b-7d1f0a5e6b4c'

const rawAgent = {
  id: AGENT_ID,
  agent_id: 'decision-data-studio-codex',
  display_name: 'Decision Data Studio',
  description: 'Decision support agent',
  capabilities: ['research'],
  languages: ['en'],
  verification_level: 'anonymous',
  reputation_score: 50,
  tier: 1,
  free_tasks_remaining: 10,
  total_tasks_completed: 0,
  success_rate: 0,
  is_active: true,
  registered_at: '2026-07-23T12:37:00.332177+00:00',
  stripe_onboarding_completed: false,
  profile_visibility: 'public',
  // A defensive response allowlist must exclude these even if a future
  // database mock or query accidentally supplies them.
  is_approved: false,
  api_key_hash: '$2b$10$not-public',
  owner_org_id: 'org-private',
  gdpr_consent_at: '2026-07-23T12:37:00.075+00:00',
  stripe_account_id: 'acct_private',
  webhook_url: 'https://private.example/webhook',
  webhook_secret: 'whsec_private',
  wallet_balance_eur: 100,
  monthly_spending_limit_eur: 200,
  embedding: [0.1, 0.2],
}

let selectedAgentColumns = ''
let selectedTaskColumns = ''
let rawOrganizations: { id: string; is_platform_seed: boolean }[] = []
let rawTransactions: { task_id: string; escrow_status: string }[] = []
// Separate from rawAgent (the single-row shape GET /agents/[id] and the
// assigned-agent lookup below both select) — attachPublicTaskFields batches
// its visibility lookup via .in(...), which resolves an array of rows, not
// one object.
let rawAgentVisibilityRows: { id: string; profile_visibility?: string }[] = []

beforeEach(() => {
  rawOrganizations = []
  rawTransactions = []
  rawAgentVisibilityRows = []
})

const rawTask = {
  id: TASK_ID,
  title: 'Analyse a B2B dataset',
  description: 'Produce a decision-ready report.',
  category: 'data_analysis',
  required_capabilities: ['research', 'analysis'],
  required_languages: ['en'],
  budget_min_eur: 300,
  budget_max_eur: 500,
  deadline_hours: 72,
  status: 'open',
  assigned_agent_id: null as string | null,
  posted_by_org_id: 'organization-private',
  bidding_closes_at: '2026-08-14T12:00:00.000Z',
  created_at: '2026-08-13T12:00:00.000Z',
  assigned_at: null,
  delivery_deadline_at: null,
  moderation_status: 'approved',
  archived_at: null as string | null,
  archived_reason: null as string | null,
  // These fields must remain private even if a query or future schema change
  // accidentally makes them available to the handler.
  buyer_email: 'buyer@example.com',
  buyer_token: 'buyer-token-private',
  delivery_note: 'Private delivered work',
  dispute_reason: 'Private buyer message',
  embedding: [0.3, 0.4],
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const result =
        table === 'agents' ? { data: rawAgent, error: null }
        : table === 'tasks' ? { data: rawTask, error: null }
        : table === 'organizations' ? { data: rawOrganizations, error: null }
        : table === 'transactions' ? { data: rawTransactions, error: null }
        : { data: [{ rating: 5 }], error: null }
      // A bare-awaited (no .single()) 'agents' query is the batched
      // visibility lookup — see the comment on rawAgentVisibilityRows above.
      const listResult = table === 'agents' ? { data: rawAgentVisibilityRows, error: null } : result

      const builder: Record<string, any> = {
        select(columns: string) {
          if (table === 'agents') selectedAgentColumns = columns
          if (table === 'tasks') selectedTaskColumns = columns
          return builder
        },
        eq: () => builder,
        in: () => builder,
        single: async () => result,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(listResult).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('GET /api/v1/agents/[id]', () => {
  it('returns only public profile fields', async () => {
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}`)
    const response = await getAgent(request, { params: { id: AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      id: AGENT_ID,
      agent_id: 'decision-data-studio-codex',
      display_name: 'Decision Data Studio',
      is_active: true,
      avg_rating: 5,
      review_count: 1,
    })
    expect(selectedAgentColumns).not.toBe('*')

    for (const privateField of [
      'is_approved',
      'api_key_hash',
      'owner_org_id',
      'gdpr_consent_at',
      'stripe_account_id',
      'webhook_url',
      'webhook_secret',
      'wallet_balance_eur',
      'monthly_spending_limit_eur',
      'embedding',
    ]) {
      expect(body).not.toHaveProperty(privateField)
      expect(selectedAgentColumns.split(',')).not.toContain(privateField)
    }
  })

  it('404s a private agent\'s profile for an anonymous caller', async () => {
    const originalVisibility = (rawAgent as any).profile_visibility
    ;(rawAgent as any).profile_visibility = 'private'
    try {
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}`)
      const response = await getAgent(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(response.status).toBe(404)
      expect(body).toEqual({ error: 'Agent not found' })
    } finally {
      ;(rawAgent as any).profile_visibility = originalVisibility
    }
  })

  it('404s a private agent\'s profile for a different agent\'s own token', async () => {
    const originalVisibility = (rawAgent as any).profile_visibility
    ;(rawAgent as any).profile_visibility = 'private'
    try {
      const token = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const response = await getAgent(request, { params: { id: AGENT_ID } })
      expect(response.status).toBe(404)
    } finally {
      ;(rawAgent as any).profile_visibility = originalVisibility
    }
  })

  it('returns a private agent\'s own profile to its own token, with private, no-store caching', async () => {
    const originalVisibility = (rawAgent as any).profile_visibility
    ;(rawAgent as any).profile_visibility = 'private'
    try {
      const token = await signToken({ agent_id: AGENT_ID, tier: 1 }, '15m')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const response = await getAgent(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.id).toBe(AGENT_ID)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(response.headers.get('Vary')).toBe('Authorization')
    } finally {
      ;(rawAgent as any).profile_visibility = originalVisibility
    }
  })

  it('returns a private agent\'s profile to an admin token', async () => {
    const originalVisibility = (rawAgent as any).profile_visibility
    ;(rawAgent as any).profile_visibility = 'private'
    try {
      const adminToken = await signToken({ tier: 'admin' }, '12h')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
      const response = await getAgent(request, { params: { id: AGENT_ID } })
      expect(response.status).toBe(200)
    } finally {
      ;(rawAgent as any).profile_visibility = originalVisibility
    }
  })
})

describe('GET /api/v1/tasks/[id]', () => {
  it('returns only public task fields', async () => {
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      id: TASK_ID,
      title: 'Analyse a B2B dataset',
      status: 'open',
      delivery_deadline_at: null,
      is_demo: false,
      funding_status: 'unfunded',
    })
    expect(selectedTaskColumns).not.toBe('*')

    for (const privateField of [
      'buyer_email',
      'buyer_token',
      'delivery_note',
      'dispute_reason',
      'embedding',
      // No raw transactions-table field may ever reach the public response
      // — only the derived funding_status may.
      'escrow_status',
      'gross_amount_eur',
      'stripe_payment_intent_id',
      'stripe_transfer_id',
    ]) {
      expect(body).not.toHaveProperty(privateField)
      expect(selectedTaskColumns.split(',')).not.toContain(privateField)
    }

    // moderation_status and posted_by_org_id are deliberately selected (the
    // handler needs them to decide 200 vs 404, and to derive is_demo below)
    // but neither may ever appear in the public response body itself.
    for (const internalOnlyField of ['moderation_status', 'posted_by_org_id']) {
      expect(selectedTaskColumns.split(',')).toContain(internalOnlyField)
      expect(body).not.toHaveProperty(internalOnlyField)
    }
  })

  it('404s a non-approved task exactly like a missing one', async () => {
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const originalStatus = rawTask.moderation_status
    rawTask.moderation_status = 'quarantined'
    try {
      const response = await getTask(request, { params: { id: TASK_ID } })
      const body = await response.json()
      expect(response.status).toBe(404)
      expect(body).toEqual({ error: 'Task not found' })
    } finally {
      rawTask.moderation_status = originalStatus
    }
  })
})

describe('GET /api/v1/tasks/[id] — archived tasks (reversible demo takedown)', () => {
  async function withArchivedTask(fn: () => Promise<void>) {
    const originalArchivedAt = rawTask.archived_at
    const originalArchivedReason = rawTask.archived_reason
    rawTask.archived_at = '2026-01-01T00:00:00.000Z'
    rawTask.archived_reason = 'demo_cleanup'
    try {
      await fn()
    } finally {
      rawTask.archived_at = originalArchivedAt
      rawTask.archived_reason = originalArchivedReason
    }
  }

  it('404s an archived task for an anonymous caller — same as a non-approved one', () => withArchivedTask(async () => {
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Task not found' })
  }))

  it('404s an archived task for a non-admin agent token too', () => withArchivedTask(async () => {
    const agentToken = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${agentToken}` },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(404)
  }))

  it('lets an admin token see the full detail of an archived task, including archived_at/archived_reason', () => withArchivedTask(async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.archived_at).toBe('2026-01-01T00:00:00.000Z')
    expect(body.archived_reason).toBe('demo_cleanup')
  }))

  it('a real, non-archived task is unaffected — still 200 for anyone', async () => {
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(200)
  })
})

describe('GET /api/v1/tasks/[id] — is_demo and funding_status', () => {
  it('is_demo is true only when the task\'s organization is flagged is_platform_seed', async () => {
    rawOrganizations = [{ id: rawTask.posted_by_org_id, is_platform_seed: true }]
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.is_demo).toBe(true)
  })

  it('is_demo is false when the organization exists but is not seed-flagged', async () => {
    rawOrganizations = [{ id: rawTask.posted_by_org_id, is_platform_seed: false }]
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.is_demo).toBe(false)
  })

  it('a client cannot spoof is_demo — GET /tasks/[id] takes no body, and a query param or header naming it is ignored', async () => {
    rawOrganizations = [{ id: rawTask.posted_by_org_id, is_platform_seed: false }]
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}?is_demo=true`, {
      headers: { 'x-is-demo': 'true' },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.is_demo).toBe(false)
  })

  it('maps a released transaction to funding_status "released"', async () => {
    rawTransactions = [{ task_id: TASK_ID, escrow_status: 'released' }]
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.funding_status).toBe('released')
  })

  it('maps a held transaction to funding_status "funded" — independent of the unrelated workflow status field', async () => {
    rawTransactions = [{ task_id: TASK_ID, escrow_status: 'held' }]
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.funding_status).toBe('funded')
    expect(body.status).toBe('open')
  })
})

describe('GET /api/v1/tasks/[id] — assigned_agent_id visibility', () => {
  // rawTask is shared module state with no per-test reset elsewhere in this
  // file (see the moderation_status test above) — mutate and restore it via
  // try/finally in every test, matching that established pattern.
  async function withPrivateAssignedAgent(fn: () => Promise<void>) {
    const originalAssignedAgentId = rawTask.assigned_agent_id
    rawTask.assigned_agent_id = OTHER_AGENT_ID
    rawAgentVisibilityRows = [{ id: OTHER_AGENT_ID, profile_visibility: 'private' }]
    try {
      await fn()
    } finally {
      rawTask.assigned_agent_id = originalAssignedAgentId
      rawAgentVisibilityRows = []
    }
  }

  it('masks a private assigned agent to null for an anonymous caller', () => withPrivateAssignedAgent(async () => {
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.assigned_agent_id).toBeNull()
    expect(JSON.stringify(body)).not.toContain(OTHER_AGENT_ID)
  }))

  it('reveals the real assigned_agent_id to the assigned agent\'s own token', () => withPrivateAssignedAgent(async () => {
    const token = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.assigned_agent_id).toBe(OTHER_AGENT_ID)
  }))

  it('keeps the internal assigned_agent_id hidden from this task\'s own buyer token', () => withPrivateAssignedAgent(async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.assigned_agent_id).toBeNull()
  }))

  it('still masks the agent for a buyer token bound to a different task', () => withPrivateAssignedAgent(async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: 'some-other-task', org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.assigned_agent_id).toBeNull()
  }))

  it('reveals the real assigned_agent_id to an admin token', () => withPrivateAssignedAgent(async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(body.assigned_agent_id).toBe(OTHER_AGENT_ID)
  }))

  it('never masks a public assigned agent — unchanged behavior', async () => {
    const originalAssignedAgentId = rawTask.assigned_agent_id
    rawTask.assigned_agent_id = OTHER_AGENT_ID
    rawAgentVisibilityRows = [{ id: OTHER_AGENT_ID, profile_visibility: 'public' }]
    try {
      const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
      const response = await getTask(request, { params: { id: TASK_ID } })
      const body = await response.json()
      expect(body.assigned_agent_id).toBe(OTHER_AGENT_ID)
    } finally {
      rawTask.assigned_agent_id = originalAssignedAgentId
      rawAgentVisibilityRows = []
    }
  })
})
