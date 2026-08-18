import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST, GET } from '@/app/api/v1/agents/[id]/stripe-onboard/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-stripe-onboard-auth-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'

const OWN_AGENT_ID = '88888888-8888-8888-8888-888888888888'
const OTHER_AGENT_ID = '99999999-9999-9999-9999-999999999999'

const agentRow = {
  id: OWN_AGENT_ID,
  agent_id: 'stripe-test-agent',
  owner_email: 'owner@example.com',
  stripe_account_id: null,
  stripe_onboarding_completed: false,
}
const agentUpdates: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: (values: Record<string, unknown>) => {
          if (table === 'agents') agentUpdates.push(values)
          return builder
        },
        single: async () => (table === 'agents' ? { data: agentRow, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))

// A financially dangerous route — this asserts real Stripe API calls are
// simply never reached for a forbidden request, not just that the HTTP
// response looks right.
const accountsCreate = vi.fn(async () => ({ id: 'acct_test123' }))
const accountLinksCreate = vi.fn(async () => ({ url: 'https://connect.stripe.com/setup/test', expires_at: Math.floor(Date.now() / 1000) + 3600 }))
const accountsRetrieve = vi.fn(async () => ({
  details_submitted: true,
  requirements: { currently_due: [] },
  charges_enabled: true,
  payouts_enabled: true,
}))
const stripeConstructor = vi.fn(function () {
  return {
    accounts: { create: accountsCreate, retrieve: accountsRetrieve },
    accountLinks: { create: accountLinksCreate },
  }
})
vi.mock('stripe', () => ({ default: stripeConstructor }))

function request(bearer: string) {
  return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({}),
  })
}

describe('POST /api/v1/agents/[id]/stripe-onboard auth', () => {
  beforeEach(() => {
    agentUpdates.length = 0
    accountsCreate.mockClear()
    accountLinksCreate.mockClear()
  })

  it('lets the agent onboard itself', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(accountsCreate).toHaveBeenCalledTimes(1)
  })

  it('rejects a different agent\'s token — the reviewed authorization gap — before touching Stripe', async () => {
    // This is the financially dangerous case: without the ownership check,
    // this call would create a real Connect account tied to OWN_AGENT_ID
    // that the caller could then finish onboarding with their own bank
    // details, redirecting that agent's future payouts.
    const token = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toMatch(/agent itself or an admin/i)
    expect(accountsCreate).not.toHaveBeenCalled()
    expect(accountLinksCreate).not.toHaveBeenCalled()
    expect(agentUpdates).toHaveLength(0)
  })

  it('rejects a buyer token before touching Stripe', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: 'x', org_id: 'org-1' }, '30d')
    const response = await POST(request(buyerToken), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(403)
    expect(accountsCreate).not.toHaveBeenCalled()
  })

  it('lets an admin token onboard any agent', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await POST(request(adminToken), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(accountsCreate).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/v1/agents/[id]/stripe-onboard auth', () => {
  beforeEach(() => {
    accountsRetrieve.mockClear()
  })

  it('rejects a different agent\'s token before touching Stripe', async () => {
    const token = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const getRequest = new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const response = await GET(getRequest, { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(403)
    expect(accountsRetrieve).not.toHaveBeenCalled()
  })
})
