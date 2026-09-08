import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-money-flow-moderation-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'

const TASK_ID = 'task-money-flow-1'
const BID_ID = 'bid-1'

let taskModerationStatus = 'approved'
let agentStripeOnboardingCompleted = true
let acceptedBidAgentVisibility = 'public'
const taskUpdates: Record<string, unknown>[] = []
const agentUpdates: Record<string, unknown>[] = []

const bidRow = { id: BID_ID, task_id: TASK_ID, agent_id: 'agent-1', price_eur: 50, delivery_hours: 24, status: 'pending' }

let accountRetrieveResult: Record<string, unknown> = {}
function resetAccountRetrieveResult() {
  accountRetrieveResult = {
    details_submitted: true,
    requirements: { currently_due: [] },
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
  }
}
resetAccountRetrieveResult()

let existingTxRow: Record<string, unknown> | null = null

const stripeAccountsRetrieve = vi.fn(async () => accountRetrieveResult)
const stripePaymentIntentsCreate = vi.fn(async () => ({ id: 'pi_test_123', client_secret: 'secret_test' }))
const stripePaymentIntentsRetrieve = vi.fn(async () => ({ status: 'requires_payment_method', payment_method_types: ['card'], client_secret: 'secret_existing_pending' }))
const stripePaymentIntentsCancel = vi.fn(async () => ({}))

vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return {
      accounts: { retrieve: stripeAccountsRetrieve },
      paymentIntents: {
        create: stripePaymentIntentsCreate,
        retrieve: stripePaymentIntentsRetrieve,
        cancel: stripePaymentIntentsCancel,
      },
    }
  }),
}))

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: () => builder,
        maybeSingle: async () => {
          if (table === 'bids') return { data: bidRow, error: null }
          if (table === 'transactions') return { data: existingTxRow, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'bids') return { data: bidRow, error: null }
          if (table === 'tasks') {
            return {
              data: {
                id: TASK_ID,
                status: 'assigned',
                assigned_agent_id: 'agent-1',
                posted_by_org_id: 'org-1',
                moderation_status: taskModerationStatus,
                agents: { id: 'agent-1', stripe_account_id: 'acct_1', stripe_onboarding_completed: agentStripeOnboardingCompleted, free_tasks_remaining: 0 },
              },
              error: null,
            }
          }
          // The insert(...).select().single() at the end of a successful
          // create-intent call reaches here for 'transactions'.
          if (table === 'transactions') return { data: { id: 'tx-fake-1' }, error: null }
          if (table === 'agents') return { data: { id: 'agent-1', profile_visibility: acceptedBidAgentVisibility }, error: null }
          return { data: null, error: null }
        },
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          if (table === 'agents') agentUpdates.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
const { fireWebhooks } = vi.hoisted(() => ({ fireWebhooks: vi.fn(async (_event: string, _payload: Record<string, unknown>) => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks }))
vi.mock('@/lib/server/fees', () => ({ calculateFees: vi.fn(() => ({ stripe_fee_eur: 1, platform_fee_eur: 2.5, agent_payout_eur: 46.5 })) }))
vi.mock('@/lib/server/settings', () => ({ getPlatformFeePercent: vi.fn(async () => 5), MAX_TRANSACTION_EUR: 10_000 }))
vi.mock('@/lib/server/paymentState', () => ({ reconcilePaymentIntent: vi.fn(async () => 'requires_action') }))

beforeEach(() => {
  taskModerationStatus = 'approved'
  agentStripeOnboardingCompleted = true
  acceptedBidAgentVisibility = 'public'
  taskUpdates.length = 0
  agentUpdates.length = 0
  existingTxRow = null
  resetAccountRetrieveResult()
  stripeAccountsRetrieve.mockClear()
  stripePaymentIntentsCreate.mockClear()
  stripePaymentIntentsRetrieve.mockClear()
  stripePaymentIntentsCancel.mockClear()
  fireWebhooks.mockClear()
})

describe('PUT /api/v1/bids/[id]/accept — moderation guard', () => {
  it('blocks accepting a bid once the task has been quarantined', async () => {
    taskModerationStatus = 'quarantined'
    const { PUT } = await import('@/app/api/v1/bids/[id]/accept/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/bids/${BID_ID}/accept`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    const response = await PUT(request, { params: { id: BID_ID } })

    expect(response.status).toBe(409)
    expect(taskUpdates).toHaveLength(0)
  })

  it('allows accepting a bid on an approved task', async () => {
    const { PUT } = await import('@/app/api/v1/bids/[id]/accept/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/bids/${BID_ID}/accept`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    const response = await PUT(request, { params: { id: BID_ID } })

    expect(response.status).toBe(200)
    expect(taskUpdates.length).toBeGreaterThan(0)
  })

  it('includes the real agent_id in the public bid.accepted webhook payload for a public agent', async () => {
    const { PUT } = await import('@/app/api/v1/bids/[id]/accept/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/bids/${BID_ID}/accept`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    await PUT(request, { params: { id: BID_ID } })

    expect(fireWebhooks).toHaveBeenCalledWith('bid.accepted', expect.objectContaining({ agent_id: 'agent-1' }))
  })

  it('never puts a private agent\'s UUID or agent_id in the public bid.accepted webhook payload', async () => {
    acceptedBidAgentVisibility = 'private'
    const { PUT } = await import('@/app/api/v1/bids/[id]/accept/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/bids/${BID_ID}/accept`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    await PUT(request, { params: { id: BID_ID } })

    expect(fireWebhooks).toHaveBeenCalledTimes(1)
    const payload = fireWebhooks.mock.calls[0][1]
    expect(payload).not.toHaveProperty('agent_id')
    expect(payload).toMatchObject({ agent_private: true })
    expect(JSON.stringify(payload)).not.toContain('agent-1')
  })
})

describe('POST /api/v1/payments/create-intent — moderation guard', () => {
  it('refuses to fund a task that is not currently approved', async () => {
    taskModerationStatus = 'quarantined'
    const { POST } = await import('@/app/api/v1/payments/create-intent/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/payments/create-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ task_id: TASK_ID }),
    })
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toMatch(/pending review/i)
  })
})

describe('POST /api/v1/payments/create-intent — live Stripe capability re-check', () => {
  function fundRequest(paymentMethod?: 'card' | 'sepa_debit') {
    return async () => {
      const { POST } = await import('@/app/api/v1/payments/create-intent/route')
      const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
      const request = new NextRequest('http://localhost/api/v1/payments/create-intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
        body: JSON.stringify({ task_id: TASK_ID, ...(paymentMethod ? { payment_method: paymentMethod } : {}) }),
      })
      return POST(request)
    }
  }

  it('rejects a card payment when card_payments is inactive, even though the stored stripe_onboarding_completed is true', async () => {
    accountRetrieveResult.capabilities = { card_payments: 'inactive', sepa_debit_payments: 'active', transfers: 'active' }
    const response = await fundRequest('card')()
    const body = await response.json()

    expect(response.status).toBe(402)
    expect(body.card_ready).toBe(false)
    expect(stripeAccountsRetrieve).toHaveBeenCalled()
    expect(stripePaymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('allows a SEPA payment when card_payments is inactive but sepa_debit_payments and transfers are active', async () => {
    accountRetrieveResult.capabilities = { card_payments: 'inactive', sepa_debit_payments: 'active', transfers: 'active' }
    const response = await fundRequest('sepa_debit')()

    expect(response.status).toBe(201)
    expect(stripePaymentIntentsCreate).toHaveBeenCalled()
  })

  it('rejects any payment method when payouts_enabled is false, regardless of capability status', async () => {
    accountRetrieveResult.payouts_enabled = false
    const response = await fundRequest()()
    const body = await response.json()

    expect(response.status).toBe(402)
    expect(body.payout_ready).toBe(false)
    expect(stripePaymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('creates the PaymentIntent when every relevant capability is active', async () => {
    const response = await fundRequest('card')()

    expect(response.status).toBe(201)
    expect(stripePaymentIntentsCreate).toHaveBeenCalled()
  })

  it('creates the PaymentIntent and syncs the DB flag to true when stripe_onboarding_completed is stored false but the account is actually ready', async () => {
    // The old early gate rejected on a stale/incorrect false without ever
    // asking Stripe — a live check must let a genuinely-ready account fund,
    // regardless of what the stored flag says.
    agentStripeOnboardingCompleted = false
    const response = await fundRequest('card')()

    expect(response.status).toBe(201)
    expect(stripePaymentIntentsCreate).toHaveBeenCalled()
    expect(agentUpdates).toContainEqual({ stripe_onboarding_completed: true })
  })

  it('rejects an invalid payment_method with 400 rather than silently defaulting to card', async () => {
    const { POST } = await import('@/app/api/v1/payments/create-intent/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/payments/create-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ task_id: TASK_ID, payment_method: 'crad' }),
    })
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatch(/payment_method/i)
    expect(stripeAccountsRetrieve).not.toHaveBeenCalled()
    expect(stripePaymentIntentsCreate).not.toHaveBeenCalled()
  })

  describe('P0 — a pending PaymentIntent must not be resumable once its capability is revoked', () => {
    beforeEach(() => {
      existingTxRow = {
        id: 'tx-pending-1',
        escrow_status: 'pending',
        stripe_payment_intent_id: 'pi_existing_pending',
        gross_amount_eur: 50,
        platform_fee_eur: 2.1,
        stripe_fee_eur: 0.4,
        agent_payout_eur: 47.5,
        review_deadline_at: '2026-01-01T00:00:00.000Z',
      }
    })

    it('does not return the pending client_secret, retrieve the intent, or create a new one when card_payments has been restricted', async () => {
      accountRetrieveResult.capabilities = { card_payments: 'inactive', sepa_debit_payments: 'active', transfers: 'active' }
      const response = await fundRequest('card')()
      const body = await response.json()

      expect(response.status).toBe(402)
      expect(body.client_secret).toBeUndefined()
      expect(body.card_ready).toBe(false)
      expect(stripePaymentIntentsRetrieve).not.toHaveBeenCalled()
      expect(stripePaymentIntentsCancel).not.toHaveBeenCalled()
      expect(stripePaymentIntentsCreate).not.toHaveBeenCalled()
    })

    it('does not return the pending client_secret, retrieve the intent, or create a new one when sepa_debit_payments has been restricted', async () => {
      accountRetrieveResult.capabilities = { card_payments: 'active', sepa_debit_payments: 'inactive', transfers: 'active' }
      const response = await fundRequest('sepa_debit')()
      const body = await response.json()

      expect(response.status).toBe(402)
      expect(body.client_secret).toBeUndefined()
      expect(body.sepa_debit_ready).toBe(false)
      expect(stripePaymentIntentsRetrieve).not.toHaveBeenCalled()
      expect(stripePaymentIntentsCreate).not.toHaveBeenCalled()
    })

    it('still resumes the pending intent normally when the capability is genuinely active', async () => {
      const response = await fundRequest('card')()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.client_secret).toBe('secret_existing_pending')
      expect(stripePaymentIntentsCreate).not.toHaveBeenCalled()
    })
  })
})
