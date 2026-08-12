import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Regression test for the unfunded-approval bug.
 *
 * Approving a task used to mark its transaction 'released' unconditionally.
 * The Stripe capture was skipped for anything that wasn't 'held', so a task
 * whose payment never completed (card abandoned at 3D Secure, SEPA still
 * settling, debit failed) could be approved: the task went to 'completed',
 * the agent was credited and a free task consumed, while no money had moved
 * — and 'released' then locked the transaction out of both the release and
 * refund paths, which only act on 'held'.
 */

const TASK_ID = '11111111-1111-1111-1111-111111111111'

let transactionRow: Record<string, unknown> | null
let taskRow: Record<string, unknown> | null
const taskUpdates: Record<string, unknown>[] = []
const transactionUpdates: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          if (table === 'transactions') transactionUpdates.push(values)
          return builder
        },
        maybeSingle: async () => ({ data: table === 'transactions' ? transactionRow : taskRow }),
        single: async () => ({ data: table === 'transactions' ? transactionRow : taskRow }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/auth', () => ({
  getTokenFromRequest: async () => ({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }),
}))

const auditLog = vi.fn(async () => {})
const applyReputationEvent = vi.fn(async () => {})
const fireWebhooks = vi.fn(async () => {})
const recordAffiliateEarning = vi.fn(async () => {})
const retrievePaymentIntent = vi.fn(async () => ({ capture_method: 'manual', status: 'requires_capture' }))
const capturePaymentIntent = vi.fn(async () => ({}))
// Must be a function expression, not an arrow — the route calls `new Stripe(...)`
const stripeConstructor = vi.fn(function () {
  return { paymentIntents: { retrieve: retrievePaymentIntent, capture: capturePaymentIntent } }
})

vi.mock('@/lib/server/audit', () => ({ auditLog }))
vi.mock('@/lib/server/reputation', () => ({ applyReputationEvent }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks }))
vi.mock('@/lib/server/affiliate', () => ({ recordAffiliateEarning }))

// Reaching Stripe at all on an unfunded payment would itself be a defect.
vi.mock('stripe', () => ({ default: stripeConstructor }))

// The real production handler — not a reimplementation of its logic.
const { PUT } = await import('@/app/api/v1/tasks/[id]/approve/route')

function approveRequest() {
  return new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/approve`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer buyer-token' },
  })
}

describe('PUT /api/v1/tasks/[id]/approve', () => {
  beforeEach(() => {
    taskUpdates.length = 0
    transactionUpdates.length = 0
    vi.clearAllMocks()
    // The route returns 400 before touching payment state unless the task is
    // in review, so every case below has to start there to reach the guard.
    taskRow = { id: TASK_ID, status: 'review', assigned_agent_id: 'agent-1' }
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  })

  function expectNoSideEffects() {
    expect(taskUpdates).toHaveLength(0)
    expect(transactionUpdates).toHaveLength(0)
    expect(stripeConstructor).not.toHaveBeenCalled()
    expect(applyReputationEvent).not.toHaveBeenCalled()
    expect(fireWebhooks).not.toHaveBeenCalled()
    expect(recordAffiliateEarning).not.toHaveBeenCalled()
  }

  for (const escrowStatus of ['pending', 'failed']) {
    it(`refuses approval and changes nothing when the payment is ${escrowStatus}`, async () => {
      transactionRow = {
        id: 'tx-1',
        task_id: TASK_ID,
        escrow_status: escrowStatus,
        platform_fee_eur: 5,
        stripe_payment_intent_id: 'pi_test',
      }

      const response = await PUT(approveRequest(), { params: { id: TASK_ID } })
      const body = await response.json()

      expect(response.status).toBe(402)
      expect(body.escrow_status).toBe(escrowStatus)
      // The money bug was the side effects, not the status code
      expectNoSideEffects()
    })
  }

  it('is idempotent when the task is completed and the payment released', async () => {
    taskRow = { id: TASK_ID, status: 'completed', assigned_agent_id: 'agent-1' }
    transactionRow = { id: 'tx-1', task_id: TASK_ID, escrow_status: 'released', platform_fee_eur: 5 }

    const response = await PUT(approveRequest(), { params: { id: TASK_ID } })

    expect(response.status).toBe(200)
    expectNoSideEffects()
  })

  it('reports a conflict when the payment is released but the task is still in review', async () => {
    transactionRow = { id: 'tx-1', task_id: TASK_ID, escrow_status: 'released', platform_fee_eur: 5 }

    const response = await PUT(approveRequest(), { params: { id: TASK_ID } })
    const body = await response.json()

    // Records disagree — reporting "already released" would hide it
    expect(response.status).toBe(409)
    expect(body.task_status).toBe('review')
    expect(body.escrow_status).toBe('released')
    expectNoSideEffects()
  })

  it('rejects approval when no payment exists at all', async () => {
    transactionRow = null

    const response = await PUT(approveRequest(), { params: { id: TASK_ID } })

    expect(response.status).toBe(402)
    expectNoSideEffects()
  })

  it('rejects approval when the task is not in review', async () => {
    taskRow = { id: TASK_ID, status: 'in_progress', assigned_agent_id: 'agent-1' }
    transactionRow = { id: 'tx-1', task_id: TASK_ID, escrow_status: 'held', platform_fee_eur: 5 }

    const response = await PUT(approveRequest(), { params: { id: TASK_ID } })

    expect(response.status).toBe(400)
    expectNoSideEffects()
  })

  // The guards above must not have made legitimate approval unreachable.
  it('captures and releases a funded payment', async () => {
    transactionRow = {
      id: 'tx-1',
      task_id: TASK_ID,
      escrow_status: 'held',
      platform_fee_eur: 5,
      agent_payout_eur: 90,
      stripe_payment_intent_id: 'pi_test',
    }

    const response = await PUT(approveRequest(), { params: { id: TASK_ID } })

    expect(response.status).toBe(200)
    expect(capturePaymentIntent).toHaveBeenCalledWith('pi_test')
    expect(taskUpdates).toContainEqual({ status: 'completed' })
    expect(transactionUpdates[0]).toMatchObject({ escrow_status: 'released' })
    expect(applyReputationEvent).toHaveBeenCalled()
    expect(fireWebhooks).toHaveBeenCalled()
  })
})
