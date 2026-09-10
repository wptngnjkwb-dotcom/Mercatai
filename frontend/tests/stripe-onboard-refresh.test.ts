import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST } from '@/app/api/v1/agents/[id]/stripe-onboard/refresh/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-stripe-onboard-refresh-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'

const OWN_AGENT_ID = '77777777-7777-7777-7777-777777777777'
const OTHER_AGENT_ID = '66666666-6666-6666-6666-666666666666'
const EXISTING_ACCOUNT_ID = 'acct_existing_de'

let agentRow: { id: string; stripe_account_id: string | null } = {
  id: OWN_AGENT_ID,
  stripe_account_id: EXISTING_ACCOUNT_ID,
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        single: async () => (table === 'agents' ? { data: agentRow, error: null } : { data: null, error: null }),
      }
      return builder
    },
  }),
}))

const { auditLog } = vi.hoisted(() => ({ auditLog: vi.fn(async (_entry: any) => {}) }))
vi.mock('@/lib/server/audit', () => ({ auditLog }))

// account.country is 'DE' — a real, distinct value the test can check the
// response actually came from Stripe's account data, not from anything the
// client supplied (this route accepts no body/query country at all).
const accountsRetrieve = vi.fn(async () => ({
  id: EXISTING_ACCOUNT_ID,
  country: 'DE',
  requirements: { disabled_reason: null },
}))
const accountsCreate = vi.fn(async () => ({ id: 'acct_should_never_be_created' }))
const accountLinksCreate = vi.fn(async () => ({
  url: 'https://connect.stripe.com/setup/refreshed-link',
  expires_at: Math.floor(Date.now() / 1000) + 1800,
}))
const stripeConstructor = vi.fn(function () {
  return {
    accounts: { retrieve: accountsRetrieve, create: accountsCreate },
    accountLinks: { create: accountLinksCreate },
  }
})
vi.mock('stripe', () => ({ default: stripeConstructor }))

function request(bearer?: string) {
  return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard/refresh`, {
    method: 'POST',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
}

describe('POST /api/v1/agents/[id]/stripe-onboard/refresh', () => {
  beforeEach(() => {
    agentRow = { id: OWN_AGENT_ID, stripe_account_id: EXISTING_ACCOUNT_ID }
    accountsRetrieve.mockClear()
    accountsCreate.mockClear()
    accountLinksCreate.mockClear()
    auditLog.mockClear()
  })

  it('mints a fresh onboarding link for the existing account when the previous one expired or was already visited', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.onboarding_url).toBe('https://connect.stripe.com/setup/refreshed-link')
    expect(body.stripe_account_id).toBe(EXISTING_ACCOUNT_ID)
    expect(accountLinksCreate).toHaveBeenCalledWith(expect.objectContaining({ account: EXISTING_ACCOUNT_ID }))
  })

  it('never creates a second connected account — only ever retrieves the existing one and mints a link for it', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    await POST(request(token), { params: { id: OWN_AGENT_ID } })

    expect(accountsCreate).not.toHaveBeenCalled()
    expect(accountsRetrieve).toHaveBeenCalledWith(EXISTING_ACCOUNT_ID)
    expect(accountLinksCreate).toHaveBeenCalledTimes(1)
  })

  it('derives the country from the live Stripe account, never from a request parameter — this endpoint accepts no country input at all', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    // Even a request carrying an unrelated body is irrelevant — the route
    // never reads request.json() for this endpoint.
    const req = new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard/refresh?country=NO`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'NO' }),
    })
    const response = await POST(req, { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    // Stripe's account object said 'DE' — that must win over the
    // query-string and body's 'NO' every time.
    expect(body.country).toBe('DE')
  })

  it('rejects an anonymous request before touching Stripe', async () => {
    const response = await POST(request(), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(401)
    expect(accountsRetrieve).not.toHaveBeenCalled()
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('rejects a different agent\'s token — cannot refresh another agent\'s onboarding link', async () => {
    const token = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toMatch(/agent itself or an admin/i)
    expect(accountsRetrieve).not.toHaveBeenCalled()
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('lets an admin token refresh any agent\'s link', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await POST(request(adminToken), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(accountLinksCreate).toHaveBeenCalled()
  })

  it('rejects a buyer token', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: 'x', org_id: 'org-1' }, '30d')
    const response = await POST(request(buyerToken), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(403)
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the agent has no existing Stripe account to refresh a link for', async () => {
    agentRow = { id: OWN_AGENT_ID, stripe_account_id: null }
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatch(/no existing account to refresh/i)
    expect(accountsRetrieve).not.toHaveBeenCalled()
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('returns 409 and does not mint a new link when the account needs manual Dashboard review', async () => {
    accountsRetrieve.mockResolvedValueOnce({
      id: EXISTING_ACCOUNT_ID,
      country: 'DE',
      requirements: { disabled_reason: 'requirements.past_due' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.action_required).toBe('manual_stripe_dashboard_review')
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('returns 404 for an agent that does not exist', async () => {
    agentRow = null as any
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(404)
  })

  it('audit-logs the account id but never the onboarding link itself', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    await POST(request(token), { params: { id: OWN_AGENT_ID } })

    expect(auditLog).toHaveBeenCalledTimes(1)
    const call = auditLog.mock.calls[0][0]
    expect(call.details.stripe_account_id).toBe(EXISTING_ACCOUNT_ID)
    expect(JSON.stringify(call)).not.toContain('connect.stripe.com')
  })
})
