import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.JWT_SECRET_KEY = 'test-secret-for-hire-moderation-32-chars!'

const insertedTasks: Record<string, unknown>[] = []
const insertedBids: Record<string, unknown>[] = []
const insertedOrgs: Record<string, unknown>[] = []
const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
let rpcCreatedNew = true
let existingHireRequest: { task_id: string; request_fingerprint: string } | null = null
const { getLiveAgentPaymentSetup, isRateLimited, recordAttempt, fireWebhooks } = vi.hoisted(() => ({
  getLiveAgentPaymentSetup: vi.fn(),
  isRateLimited: vi.fn(async () => false),
  recordAttempt: vi.fn(async () => {}),
  fireWebhooks: vi.fn(async () => {}),
}))

const listingRow = {
  id: 'listing-1',
  title: 'Translate a document',
  description: 'A perfectly ordinary translation service with no red flags at all.',
  category: 'translation',
  price_eur: 50,
  delivery_hours: 24,
  hires_count: 0,
  agent_id: 'agent-1',
  is_active: true,
  status: 'active',
  moderation_status: 'approved',
  agents: {
    id: 'agent-1', display_name: 'Translator Bot', is_active: true, profile_visibility: 'public',
    owner_email: 'operator@example.com', stripe_standard_account_id: null,
    stripe_standard_onboarding_completed: false,
  },
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return { data: [{
        task_id: 'task-1', buyer_org_id: 'org-1', agent_id: 'agent-1',
        task_title: listingRow.title, price_eur: listingRow.price_eur,
        delivery_hours: listingRow.delivery_hours,
        agent_display_name: listingRow.agents.display_name,
        assigned_at: '2026-09-01T00:00:00.000Z',
        created_new: rpcCreatedNew,
      }], error: null }
    },
    from(table: string) {
      let insertedRow: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        single: async () => {
          if (table === 'agent_listings') return { data: listingRow, error: null }
          if (table === 'agents') return { data: { id: 'agent-1', profile_visibility: listingRow.agents.profile_visibility }, error: null }
          if (table === 'organizations') return { data: { id: 'org-1' }, error: null }
          if (table === 'tasks') return { data: { id: 'task-1', assigned_agent_id: 'agent-1', ...(insertedRow ?? {}) }, error: null }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'organizations') return { data: null, error: null }
          if (table === 'store_hire_requests') return { data: existingHireRequest, error: null }
          return { data: null, error: null }
        },
        insert: (values: Record<string, unknown>) => {
          if (table === 'tasks') { insertedTasks.push(values); insertedRow = values }
          if (table === 'bids') insertedBids.push(values)
          if (table === 'organizations') insertedOrgs.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
const { sendTaskCreated, sendBidAcceptedActionRequired } = vi.hoisted(() => ({
  sendTaskCreated: vi.fn(async () => {}),
  sendBidAcceptedActionRequired: vi.fn(async () => {}),
}))
vi.mock('@/lib/server/email', () => ({ sendTaskCreated, sendBidAcceptedActionRequired }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks }))
vi.mock('@/lib/server/rateLimit', () => ({
  clientIp: vi.fn((request: NextRequest) => request.headers.get('x-forwarded-for')),
  isRateLimited,
  recordAttempt,
}))
vi.mock('@/lib/server/agentPaymentSetup', () => ({
  getLiveAgentPaymentSetup,
  paymentSetupRequiredBody: vi.fn((result: any) => ({ code: 'agent_payment_setup_required', payment_setup_status: result.status, next_action: result.nextAction })),
  PaymentSetupLookupError: class PaymentSetupLookupError extends Error {},
}))

beforeEach(() => {
  insertedTasks.length = 0
  insertedBids.length = 0
  insertedOrgs.length = 0
  rpcCalls.length = 0
  rpcCreatedNew = true
  existingHireRequest = null
  sendTaskCreated.mockClear()
  sendBidAcceptedActionRequired.mockClear()
  getLiveAgentPaymentSetup.mockReset()
  isRateLimited.mockReset()
  isRateLimited.mockResolvedValue(false)
  recordAttempt.mockClear()
  fireWebhooks.mockClear()
  getLiveAgentPaymentSetup.mockResolvedValue({ ready: true, status: 'ready', nextAction: 'ready_to_bid', accountId: 'acct_standard_test', country: 'CZ', onboardingEndpoint: '/api/v1/agents/agent-1/stripe-onboard', reason: null })
})

const hireHeaders = {
  'content-type': 'application/json',
  'idempotency-key': 'test-hire-request-0001',
}

describe('POST /api/v1/store/[listingId]/hire — moderation', () => {
  it('requires an idempotency key before any lookup or write', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const response = await POST(new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
    }), { params: { listingId: 'listing-1' } })

    expect(response.status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
  })

  it('rate-limits anonymous Store hire attempts before lookup or side effects', async () => {
    isRateLimited.mockResolvedValueOnce(true)
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const response = await POST(new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: { ...hireHeaders, 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
    }), { params: { listingId: 'listing-1' } })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('3600')
    expect(recordAttempt).not.toHaveBeenCalled()
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
    expect(rpcCalls).toHaveLength(0)
  })

  it('rejects a provider without ready Standard payments before moderation or any hire write', async () => {
    getLiveAgentPaymentSetup.mockResolvedValueOnce({ ready: false, status: 'onboarding_required', nextAction: 'continue_stripe_onboarding', accountId: 'acct_standard_test', country: 'CZ', onboardingEndpoint: '/api/v1/agents/agent-1/stripe-onboard', reason: 'stripe_requirements_incomplete' })
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const response = await POST(new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST', headers: hireHeaders, body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
    }), { params: { listingId: 'listing-1' } })

    expect(response.status).toBe(402)
    expect(rpcCalls).toHaveLength(0)
    expect(insertedTasks).toHaveLength(0)
    expect(insertedBids).toHaveLength(0)
    expect(insertedOrgs).toHaveLength(0)
  })

  it('persists moderation_status=approved and published_at on a hired task — the reported gap', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: hireHeaders,
      body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
    })
    const response = await POST(request, { params: { listingId: 'listing-1' } })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]).toMatchObject({ name: 'create_store_hire', args: {
      p_listing_id: 'listing-1', p_expected_agent_id: 'agent-1',
      p_moderation_policy_version: expect.any(String),
      p_idempotency_key: 'test-hire-request-0001',
      p_request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    } })
    // Organization, approved task, accepted bid and counter are created
    // inside this single transaction rather than independent app writes.
    expect(insertedTasks).toHaveLength(0)
    expect(insertedBids).toHaveLength(0)
    expect(body).toHaveProperty('task_id')
    expect(body.delivery_deadline_at).toBeNull()
    expect(sendBidAcceptedActionRequired).toHaveBeenCalledWith(expect.objectContaining({
      to: 'operator@example.com', taskId: 'task-1', agentId: 'agent-1', onboardingRequired: true,
    }))
    expect(fireWebhooks).not.toHaveBeenCalled()
  })

  it('blocks a listing whose content fails moderation, creating nothing', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const original = { ...listingRow }
    Object.assign(listingRow, {
      title: 'Verify wallet',
      description: 'We just need your seed phrase to confirm you own the wallet, nothing else.',
    })
    try {
      const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
        method: 'POST',
        headers: hireHeaders,
        body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
      })
      const response = await POST(request, { params: { listingId: 'listing-1' } })
      expect(response.status).toBe(422)
      expect(insertedTasks).toHaveLength(0)
      expect(insertedBids).toHaveLength(0)
    } finally {
      Object.assign(listingRow, original)
    }
  })

  it('org_name is never used to look up or attach to an existing organization', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: hireHeaders,
      body: JSON.stringify({ org_name: 'Mercatai Sample Briefs', buyer_email: 'buyer@example.com' }),
    })
    const response = await POST(request, { params: { listingId: 'listing-1' } })
    expect(response.status).toBe(201)
    expect(insertedOrgs).toHaveLength(0)
    expect(rpcCalls[0]).toMatchObject({ args: { p_org_name: 'Mercatai Sample Briefs' } })
  })

  it('returns the original private task on a replay without repeating email side effects', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const first = await POST(new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: hireHeaders,
      body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
    }), { params: { listingId: 'listing-1' } })
    expect(first.status).toBe(201)

    existingHireRequest = {
      task_id: 'task-1',
      request_fingerprint: String(rpcCalls[0].args.p_request_fingerprint),
    }
    rpcCreatedNew = false
    rpcCalls.length = 0
    sendTaskCreated.mockClear()
    sendBidAcceptedActionRequired.mockClear()
    getLiveAgentPaymentSetup.mockReset()
    getLiveAgentPaymentSetup.mockRejectedValue(new Error('Stripe unavailable during retry'))
    const response = await POST(new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: hireHeaders,
      body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
    }), { params: { listingId: 'listing-1' } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ task_id: 'task-1', idempotent_replay: true, visibility: 'private', source: 'store' })
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
    expect(rpcCalls).toHaveLength(1)
    expect(sendTaskCreated).not.toHaveBeenCalled()
    expect(sendBidAcceptedActionRequired).not.toHaveBeenCalled()
  })

  it('rejects reuse of the same key with different request content', async () => {
    existingHireRequest = { task_id: 'task-1', request_fingerprint: 'a'.repeat(64) }
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const response = await POST(new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: hireHeaders,
      body: JSON.stringify({ buyer_email: 'different@example.com' }),
    }), { params: { listingId: 'listing-1' } })

    expect(response.status).toBe(409)
    expect(rpcCalls).toHaveLength(0)
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/store/[listingId]/hire — private-agent listing', () => {
  it('rejects instant-hire by direct listingId when the listing\'s agent is private — a known listingId must not bypass the Store list filter', async () => {
    const original = { ...listingRow, agents: { ...listingRow.agents } }
    Object.assign(listingRow, { agents: { ...listingRow.agents, profile_visibility: 'private' } })
    try {
      const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
      const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
        method: 'POST',
        headers: hireHeaders,
        body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
      })
      const response = await POST(request, { params: { listingId: 'listing-1' } })

      expect(response.status).toBe(404)
      expect(insertedTasks).toHaveLength(0)
      expect(insertedBids).toHaveLength(0)
    } finally {
      Object.assign(listingRow, original)
    }
  })

  it('fails closed when the joined agent has no recognized visibility value', async () => {
    const original = { ...listingRow, agents: { ...listingRow.agents } }
    Object.assign(listingRow, { agents: { ...listingRow.agents, profile_visibility: 'future-mode' as any } })
    try {
      const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
      const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
        method: 'POST',
        headers: hireHeaders,
        body: JSON.stringify({ buyer_email: 'buyer@example.com' }),
      })
      const response = await POST(request, { params: { listingId: 'listing-1' } })
      expect(response.status).toBe(404)
      expect(insertedTasks).toHaveLength(0)
    } finally {
      Object.assign(listingRow, original)
    }
  })
})
