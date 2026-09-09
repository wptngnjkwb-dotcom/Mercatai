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
let dbAgentUpdateError: { message: string } | null = null

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
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: table === 'agents' ? dbAgentUpdateError : null }),
      }
      return builder
    },
  }),
}))

const { auditLog } = vi.hoisted(() => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/audit', () => ({ auditLog }))

// A financially dangerous route — this asserts real Stripe API calls are
// simply never reached for a forbidden request, not just that the HTTP
// response looks right.
const accountsCreate = vi.fn(async () => ({ id: 'acct_test123' }))
const accountsUpdate = vi.fn(async () => ({ id: 'acct_existing' }))
const accountLinksCreate = vi.fn(async () => ({ url: 'https://connect.stripe.com/setup/test', expires_at: Math.floor(Date.now() / 1000) + 3600 }))
const accountsRetrieve = vi.fn(async () => ({
  details_submitted: true,
  requirements: { currently_due: [] },
  charges_enabled: true,
  payouts_enabled: true,
  capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
}))
const stripeConstructor = vi.fn(function () {
  return {
    accounts: { create: accountsCreate, retrieve: accountsRetrieve, update: accountsUpdate },
    accountLinks: { create: accountLinksCreate },
  }
})
vi.mock('stripe', () => ({ default: stripeConstructor }))

// country is required by the route (see the "country and business_type
// validation" describe block below) — these auth-focused tests supply a
// valid one so they can reach and test the authorization logic itself.
function request(bearer: string) {
  return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ country: 'CZ' }),
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

  it('fails clearly, before calling Stripe, when the agent has no owner_email on file', async () => {
    // Reachable for an agent that pre-dates owner_email being required and
    // whose organization name was never itself an email (the migration
    // backfill has nothing to copy from) — must not silently pass a null
    // email through to Stripe's account-creation call.
    const original = agentRow.owner_email
    ;(agentRow as any).owner_email = null
    try {
      const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
      const response = await POST(request(token), { params: { id: OWN_AGENT_ID } })
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.error).toMatch(/contact email/i)
      expect(accountsCreate).not.toHaveBeenCalled()
    } finally {
      ;(agentRow as any).owner_email = original
    }
  })
})

describe('POST /api/v1/agents/[id]/stripe-onboard — country and business_type validation', () => {
  beforeEach(() => {
    agentUpdates.length = 0
    accountsCreate.mockClear()
    accountLinksCreate.mockClear()
  })

  function requestWithBody(bearer: string, body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    })
  }

  it('rejects a request with no country at all, before ever calling Stripe', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, {}), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatch(/country is required/i)
    expect(accountsCreate).not.toHaveBeenCalled()
  })

  it('rejects a country not on the supported list before ever calling Stripe — no silent CZ default', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'XX' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatch(/not currently supported for onboarding/i)
    expect(accountsCreate).not.toHaveBeenCalled()
  })

  it('rejects a non-alphabetic, garbage country value before ever calling Stripe', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: '12' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(400)
    expect(accountsCreate).not.toHaveBeenCalled()
  })

  it('accepts the Norwegian country code NO and passes it through to Stripe', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'no' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(accountsCreate).toHaveBeenCalledWith(expect.objectContaining({ country: 'NO' }))
  })

  it('accepts every EU member represented by a non-default example and provisions card, SEPA, and transfers', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'DE' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(accountsCreate).toHaveBeenCalledWith(expect.objectContaining({
      country: 'DE',
      capabilities: {
        card_payments: { requested: true },
        sepa_debit_payments: { requested: true },
        transfers: { requested: true },
      },
    }))
  })

  it('accepts a documented non-EEA Stripe Connect country without requesting the EU-only SEPA capability', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'PE' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.supported_payment_methods).toEqual(['card'])
    expect(accountsCreate).toHaveBeenCalledWith(expect.objectContaining({
      country: 'PE',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    }))
    expect((accountsCreate as any).mock.calls[0][0].capabilities).not.toHaveProperty('sepa_debit_payments')
  })

  it('does not hardcode business_type — omits it from the Stripe call when the caller does not supply one', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'NO' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    const createArgs = (accountsCreate as any).mock.calls[0][0]
    expect(createArgs).not.toHaveProperty('business_type')
  })

  it('passes through an explicit, valid business_type (e.g. individual, for a sole proprietor)', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'NO', business_type: 'individual' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(accountsCreate).toHaveBeenCalledWith(expect.objectContaining({ business_type: 'individual' }))
  })

  it('rejects an invalid business_type before ever calling Stripe', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'CZ', business_type: 'sole_trader' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(400)
    expect(accountsCreate).not.toHaveBeenCalled()
  })

  it('requests card_payments alongside sepa_debit_payments and transfers, so on_behalf_of destination charges work for both methods', async () => {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'CZ' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    const createArgs = (accountsCreate as any).mock.calls[0][0]
    expect(createArgs.capabilities).toMatchObject({
      card_payments: { requested: true },
      sepa_debit_payments: { requested: true },
      transfers: { requested: true },
    })
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

describe('GET /api/v1/agents/[id]/stripe-onboard — onboarding completeness derived live from Stripe', () => {
  beforeEach(() => {
    agentUpdates.length = 0
    accountsRetrieve.mockClear()
    auditLog.mockClear()
    dbAgentUpdateError = null
    ;(agentRow as any).stripe_account_id = 'acct_existing'
  })

  async function getStatus() {
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const getRequest = new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return GET(getRequest, { params: { id: OWN_AGENT_ID } })
  }

  it('sets onboarding_completed=true and reports per-method readiness when identity, payouts/transfers, and a payment method are all ready', async () => {
    ;(agentRow as any).stripe_onboarding_completed = false
    accountsRetrieve.mockResolvedValueOnce({
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    })

    const response = await getStatus()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.onboarding_completed).toBe(true)
    expect(body.payout_ready).toBe(true)
    expect(body.card_ready).toBe(true)
    expect(body.sepa_debit_ready).toBe(true)
    expect(agentUpdates).toContainEqual({ stripe_onboarding_completed: true })
  })

  it('resets a historically-true stripe_onboarding_completed back to false once Stripe reports no usable payment method — a stored true must not survive a later restriction', async () => {
    ;(agentRow as any).stripe_onboarding_completed = true
    accountsRetrieve.mockResolvedValueOnce({
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'inactive', sepa_debit_payments: 'inactive', transfers: 'active' },
    })

    const response = await getStatus()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.onboarding_completed).toBe(false)
    expect(body.card_ready).toBe(false)
    expect(body.sepa_debit_ready).toBe(false)
    expect(agentUpdates).toContainEqual({ stripe_onboarding_completed: false })
  })

  it('resets a historically-true stripe_onboarding_completed back to false once payouts_enabled turns false, even with active capabilities', async () => {
    ;(agentRow as any).stripe_onboarding_completed = true
    accountsRetrieve.mockResolvedValueOnce({
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: false,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    })

    const response = await getStatus()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.onboarding_completed).toBe(false)
    expect(body.payout_ready).toBe(false)
    expect(agentUpdates).toContainEqual({ stripe_onboarding_completed: false })
  })

  it('does not write to the database when the computed status already matches the stored one', async () => {
    ;(agentRow as any).stripe_onboarding_completed = true
    accountsRetrieve.mockResolvedValueOnce({
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    })

    const response = await getStatus()
    expect(response.status).toBe(200)
    expect(agentUpdates).toHaveLength(0)
  })

  it('fails closed — never audit-logs a completion/restriction claim when the database write itself fails', async () => {
    ;(agentRow as any).stripe_onboarding_completed = false
    accountsRetrieve.mockResolvedValueOnce({
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    })
    dbAgentUpdateError = { message: 'connection reset' }
    try {
      await expect(getStatus()).rejects.toThrow(/failed to sync/i)
      expect(auditLog).not.toHaveBeenCalled()
    } finally {
      dbAgentUpdateError = null
    }
  })
})

describe('POST /api/v1/agents/[id]/stripe-onboard — existing-account remediation', () => {
  beforeEach(() => {
    agentUpdates.length = 0
    accountsCreate.mockClear()
    accountsUpdate.mockClear()
    accountLinksCreate.mockClear()
    accountsRetrieve.mockClear()
    ;(agentRow as any).stripe_account_id = 'acct_existing'
  })

  function requestWithBody(bearer: string, body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    })
  }

  it("rejects with 409 when the request country does not match the existing account's country — does not create a second account", async () => {
    accountsRetrieve.mockResolvedValueOnce({
      country: 'CZ',
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'NO' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.existing_country).toBe('CZ')
    expect(accountsCreate).not.toHaveBeenCalled()
    expect(accountsUpdate).not.toHaveBeenCalled()
  })

  it('requests missing capabilities on an existing account created before card_payments was added, then issues a fresh onboarding link', async () => {
    accountsRetrieve.mockResolvedValueOnce({
      country: 'CZ',
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      // Legacy account: sepa_debit_payments alone already satisfies
      // onboardingComplete (at least one method + payout ready), so this
      // also proves card_payments still gets requested even though the
      // account isn't "incomplete" by that looser bar.
      capabilities: { sepa_debit_payments: 'active', transfers: 'active' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'CZ' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.onboarding_url).toBeTruthy()
    expect(accountsUpdate).toHaveBeenCalledWith('acct_existing', {
      capabilities: expect.objectContaining({ card_payments: { requested: true } }),
    })
    expect(accountsCreate).not.toHaveBeenCalled()
  })

  it('returns "already completed" without calling accounts.update when every capability is already active', async () => {
    accountsRetrieve.mockResolvedValueOnce({
      country: 'CZ',
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'CZ' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.message).toMatch(/already completed/i)
    expect(accountsUpdate).not.toHaveBeenCalled()
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('does not demand SEPA from a completed non-EEA account whose country profile is card-only', async () => {
    accountsRetrieve.mockResolvedValueOnce({
      country: 'PE',
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', transfers: 'active' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'PE' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.message).toMatch(/already completed/i)
    expect(accountsUpdate).not.toHaveBeenCalled()
    expect(accountLinksCreate).not.toHaveBeenCalled()
  })

  it('does not report "already completed" when payouts_enabled is false, even with every capability active — and does not call accounts.update with nothing to request', async () => {
    accountsRetrieve.mockResolvedValueOnce({
      country: 'CZ',
      details_submitted: true,
      requirements: { currently_due: [] },
      charges_enabled: true,
      payouts_enabled: false,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'CZ' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.message).toBeUndefined()
    expect(body.onboarding_url).toBeTruthy()
    expect(accountsUpdate).not.toHaveBeenCalled()
    expect(accountLinksCreate).toHaveBeenCalled()
  })

  it('does not report "already completed" when details_submitted is false, even with every capability active', async () => {
    accountsRetrieve.mockResolvedValueOnce({
      country: 'CZ',
      details_submitted: false,
      requirements: { currently_due: ['individual.id_number'] },
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    } as any)
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(requestWithBody(token, { country: 'CZ' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.message).toBeUndefined()
    expect(body.onboarding_url).toBeTruthy()
    expect(accountsUpdate).not.toHaveBeenCalled()
    expect(accountLinksCreate).toHaveBeenCalled()
  })
})

describe('POST /api/v1/agents/[id]/stripe-onboard — orphaned account on DB write failure', () => {
  beforeEach(() => {
    agentUpdates.length = 0
    accountsCreate.mockClear()
    accountLinksCreate.mockClear()
    ;(agentRow as any).stripe_account_id = null
  })

  function requestWithBody(bearer: string, body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/stripe-onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    })
  }

  it('does not return a successful onboarding link when saving the new stripe_account_id to the agent record fails', async () => {
    dbAgentUpdateError = { message: 'connection reset' }
    try {
      const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
      const response = await POST(requestWithBody(token, { country: 'CZ' }), { params: { id: OWN_AGENT_ID } })
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body.onboarding_url).toBeUndefined()
      expect(body.stripe_account_id).toBe('acct_test123')
      expect(accountLinksCreate).not.toHaveBeenCalled()
    } finally {
      dbAgentUpdateError = null
    }
  })
})
