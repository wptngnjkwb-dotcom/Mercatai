import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { getLiveAgentPaymentSetup, auditLog } = vi.hoisted(() => ({
  getLiveAgentPaymentSetup: vi.fn(),
  auditLog: vi.fn(async () => {}),
}))

const insertedListings: Record<string, unknown>[] = []
const agent = {
  id: 'agent-db-1',
  profile_visibility: 'public',
  is_active: true,
  stripe_standard_account_id: 'acct_standard_test',
  stripe_standard_onboarding_completed: true,
}

vi.mock('@/lib/server/auth', () => ({
  getTokenFromRequest: vi.fn(async () => ({ role: 'agent', agent_id: 'agent-db-1' })),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog }))

vi.mock('@/lib/server/agentPaymentSetup', () => ({
  getLiveAgentPaymentSetup,
  paymentSetupRequiredBody: vi.fn((result: any) => ({
    code: 'agent_payment_setup_required',
    payment_setup_status: result.status,
    next_action: result.nextAction,
  })),
  PaymentSetupLookupError: class PaymentSetupLookupError extends Error {},
}))

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      let inserted: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        insert: (value: Record<string, unknown>) => {
          inserted = value
          if (table === 'agent_listings') insertedListings.push(value)
          return builder
        },
        single: async () => {
          if (table === 'agents') return { data: agent, error: null }
          if (table === 'agent_listings' && inserted) {
            return { data: { id: 'listing-1', ...inserted }, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'agent_listings') return resolve({ data: null, count: 0, error: null })
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }),
}))

beforeEach(() => {
  insertedListings.length = 0
  auditLog.mockClear()
  getLiveAgentPaymentSetup.mockReset()
  getLiveAgentPaymentSetup.mockResolvedValue({
    ready: true,
    status: 'ready',
    nextAction: 'ready_to_bid',
    accountId: 'acct_standard_test',
    country: 'CZ',
    onboardingEndpoint: '/api/v1/agents/agent-db-1/stripe-onboard',
    reason: null,
  })
})

function createRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/v1/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Source-backed market research',
      description: 'I will produce a concise source-backed table from public information.',
      category: 'research',
      price_eur: 25,
      delivery_hours: 24,
      pricing_mode: 'fixed',
      included_items: ['Source-backed result table', 'Executive summary'],
      required_inputs: ['Target market'],
      output_formats: ['csv', 'pdf'],
      revision_count: 1,
      ...overrides,
    }),
  })
}

describe('POST /api/v1/store — publication hardening', () => {
  it('requires a live-ready Standard account before publication', async () => {
    getLiveAgentPaymentSetup.mockResolvedValueOnce({
      ready: false,
      status: 'onboarding_required',
      nextAction: 'continue_stripe_onboarding',
      accountId: null,
      country: 'CZ',
      onboardingEndpoint: '/api/v1/agents/agent-db-1/stripe-onboard',
      reason: 'missing_standard_account',
    })
    const { POST } = await import('@/app/api/v1/store/route')
    const response = await POST(createRequest())

    expect(response.status).toBe(402)
    expect(insertedListings).toHaveLength(0)
  })

  it('rejects invalid categories and delivery windows before payment lookup', async () => {
    const { POST } = await import('@/app/api/v1/store/route')
    const invalidCategory = await POST(createRequest({ category: 'crypto_wallet_recovery' }))
    const invalidDelivery = await POST(createRequest({ delivery_hours: 0 }))
    const invalidPricePrecision = await POST(createRequest({ price_eur: 1.001 }))

    expect(invalidCategory.status).toBe(400)
    expect(invalidDelivery.status).toBe(400)
    expect(invalidPricePrecision.status).toBe(400)
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
    expect(insertedListings).toHaveLength(0)
  })

  it('rejects invalid structured terms before payment lookup', async () => {
    const { POST } = await import('@/app/api/v1/store/route')
    const invalidMode = await POST(createRequest({ pricing_mode: 'starting_at' }))
    const invalidRevisions = await POST(createRequest({ revision_count: 11 }))
    const invalidFormat = await POST(createRequest({ output_formats: ['csv', 'executable'] }))

    expect(invalidMode.status).toBe(400)
    expect(invalidRevisions.status).toBe(400)
    expect(invalidFormat.status).toBe(400)
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
    expect(insertedListings).toHaveLength(0)
  })

  it('blocks unsafe listing content without creating a public row', async () => {
    const { POST } = await import('@/app/api/v1/store/route')
    const response = await POST(createRequest({
      title: 'Verify a wallet',
      description: 'Send me your seed phrase so I can verify the wallet for you.',
    }))

    expect([202, 422]).toContain(response.status)
    expect(insertedListings).toHaveLength(0)
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'listing_publication_blocked' }))
  })

  it('blocks direct contact and external destinations before payment lookup', async () => {
    const { POST } = await import('@/app/api/v1/store/route')
    const response = await POST(createRequest({
      description: 'I will deliver the report. Contact me at agent@example.com or https://outside.example.com.',
    }))
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body).toMatchObject({
      code: 'off_platform_contact_not_allowed',
      reason_codes: expect.arrayContaining(['EMAIL_ADDRESS', 'EXTERNAL_URL']),
    })
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
    expect(insertedListings).toHaveLength(0)
  })

  it('applies the contact policy to every structured term', async () => {
    const { POST } = await import('@/app/api/v1/store/route')
    const response = await POST(createRequest({
      included_items: ['Source table', 'Follow-up at https://outside.example.com'],
      required_inputs: ['Telegram @outside_agent'],
    }))
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body).toMatchObject({ code: 'off_platform_contact_not_allowed' })
    expect(body.reason_codes).toEqual(expect.arrayContaining(['EXTERNAL_URL', 'MESSAGING_CONTACT']))
    expect(getLiveAgentPaymentSetup).not.toHaveBeenCalled()
    expect(insertedListings).toHaveLength(0)
  })

  it('publishes an approved, moderated active listing with an auditable lifecycle', async () => {
    const { POST } = await import('@/app/api/v1/store/route')
    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(insertedListings).toHaveLength(1)
    expect(insertedListings[0]).toMatchObject({
      agent_id: 'agent-db-1',
      status: 'active',
      is_active: true,
      moderation_status: 'approved',
      moderation_policy_version: expect.any(String),
      published_at: expect.any(String),
      pricing_mode: 'fixed',
      included_items: ['Source-backed result table', 'Executive summary'],
      required_inputs: ['Target market'],
      output_formats: ['csv', 'pdf'],
      revision_count: 1,
    })
    expect(body).toMatchObject({ id: 'listing-1', status: 'active', moderation_status: 'approved' })
  })
})
