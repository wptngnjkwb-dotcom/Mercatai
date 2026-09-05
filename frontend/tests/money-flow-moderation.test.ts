import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-money-flow-moderation-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'

const TASK_ID = 'task-money-flow-1'
const BID_ID = 'bid-1'

let taskModerationStatus = 'approved'
const taskUpdates: Record<string, unknown>[] = []

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

const stripeAccountsRetrieve = vi.fn(async () => accountRetrieveResult)
const stripePaymentIntentsCreate = vi.fn(async () => ({ id: 'pi_test_123', client_secret: 'secret_test' }))
const stripePaymentIntentsRetrieve = vi.fn(async () => ({ status: 'requires_payment_method', payment_method_types: ['card'] }))
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
          if (table === 'transactions') return { data: null, error: null }
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
                agents: { id: 'agent-1', stripe_account_id: 'acct_1', stripe_onboarding_completed: true, free_tasks_remaining: 0 },
              },
              error: null,
            }
          }
          // The insert(...).select().single() at the end of a successful
          // create-intent call reaches here for 'transactions'.
          if (table === 'transactions') return { data: { id: 'tx-fake-1' }, error: null }
          return { data: null, error: null }
        },
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/fees', () => ({ calculateFees: vi.fn(() => ({ stripe_fee_eur: 1, platform_fee_eur: 2.5, agent_payout_eur: 46.5 })) }))
vi.mock('@/lib/server/settings', () => ({ getPlatformFeePercent: vi.fn(async () => 5), MAX_TRANSACTION_EUR: 10_000 }))
vi.mock('@/lib/server/paymentState', () => ({ reconcilePaymentIntent: vi.fn(async () => 'requires_action') }))

beforeEach(() => {
  taskModerationStatus = 'approved'
  taskUpdates.length = 0
  resetAccountRetrieveResult()
  stripeAccountsRetrieve.mockClear()
  stripePaymentIntentsCreate.mockClear()
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
})
