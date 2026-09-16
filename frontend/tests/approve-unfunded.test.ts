import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
// The real production handler — not a reimplementation of its logic.
import { PUT } from '@/app/api/v1/tasks/[id]/approve/route'

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
const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
const ASSIGNED_AGENT_ID = 'agent-1'
let assignedAgentVisibility = 'public'
let finalizeRpcError: Record<string, unknown> | null = null
let identityRpcError: Record<string, unknown> | null = null

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      // Mirrors frontend/sql/20_payment_charge_transfer_identity.sql's
      // compare-and-set semantics closely enough for this file's purpose —
      // full coverage of that logic lives in
      // tests/payment-charge-transfer-identity.test.ts and
      // tests/stripe-webhook.test.ts; this just proves approve.ts calls it
      // with the right args right after a real capture.
      if (name === 'record_payment_charge_identity') {
        if (identityRpcError) return { data: null, error: identityRpcError }
        if (transactionRow) {
          transactionRow.stripe_charge_id = args.p_stripe_charge_id
          transactionRow.stripe_transfer_id = args.p_stripe_transfer_id
        }
        return { data: [{
          transaction_id: args.p_transaction_id,
          stripe_charge_id: args.p_stripe_charge_id, stripe_transfer_id: args.p_stripe_transfer_id,
          charge_id_written: true, transfer_id_written: true,
          charge_id_conflict: false, transfer_id_conflict: false,
        }], error: null }
      }
      if (finalizeRpcError) return { data: null, error: finalizeRpcError }
      return { data: [{
        task_status: 'completed', transaction_status: 'released',
        assigned_agent_id: ASSIGNED_AGENT_ID, agent_payout_eur: 90,
        platform_fee_eur: transactionRow?.platform_fee_eur ?? 5,
        newly_completed: true,
      }], error: null }
    },
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          if (table === 'transactions') transactionUpdates.push(values)
          return builder
        },
        maybeSingle: async () => ({ data: table === 'transactions' ? transactionRow : taskRow }),
        single: async () => {
          if (table === 'transactions') return { data: transactionRow }
          if (table === 'agents') return { data: { id: ASSIGNED_AGENT_ID, profile_visibility: assignedAgentVisibility } }
          return { data: taskRow }
        },
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/auth', () => ({
  getTokenFromRequest: async () => ({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }),
}))

// vi.hoisted so the spies exist before the hoisted vi.mock factories run —
// that also lets the handler be a plain static import instead of a top-level
// await, which the project's tsconfig (no `target`) rejects.
const {
  fireWebhooks,
  recordAffiliateEarning,
  retrievePaymentIntent,
  capturePaymentIntent,
  retrieveCharge,
  stripeConstructor,
} = vi.hoisted(() => {
  // requires_capture pre-capture, succeeded (with a charge) once "captured"
  // below flips it — close enough to Stripe's real behavior for this
  // file's purpose without needing a full state machine. Derived from the
  // capture spy's own call count (reset by this file's vi.clearAllMocks()
  // in beforeEach) rather than a separate closure flag, so it can never
  // leak stale "captured" state into the next test.
  const capture = vi.fn(async () => ({}))
  const retrieve = vi.fn(async () => (
    capture.mock.calls.length > 0
      ? { id: 'pi_test', capture_method: 'manual', status: 'succeeded', latest_charge: 'ch_test' }
      : { id: 'pi_test', capture_method: 'manual', status: 'requires_capture' }
  ))
  const retrieveCharge = vi.fn(async (id: string) => ({ id, transfer: 'tr_test' }))
  return {
    fireWebhooks: vi.fn(async (_event: string, _payload: Record<string, unknown>) => {}),
    recordAffiliateEarning: vi.fn(async () => {}),
    retrievePaymentIntent: retrieve,
    capturePaymentIntent: capture,
    retrieveCharge,
    // Must be a function expression, not an arrow — the route calls `new Stripe(...)`
    stripeConstructor: vi.fn(function () {
      return { paymentIntents: { retrieve, capture }, charges: { retrieve: retrieveCharge } }
    }),
  }
})

vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks }))
vi.mock('@/lib/server/affiliate', () => ({ recordAffiliateEarning }))

// Reaching Stripe at all on an unfunded payment would itself be a defect.
vi.mock('stripe', () => ({ default: stripeConstructor }))

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
    rpcCalls.length = 0
    vi.clearAllMocks()
    // The route returns 400 before touching payment state unless the task is
    // in review, so every case below has to start there to reach the guard.
    taskRow = { id: TASK_ID, status: 'review', assigned_agent_id: 'agent-1' }
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    assignedAgentVisibility = 'public'
    finalizeRpcError = null
    identityRpcError = null
  })

  function expectNoSideEffects() {
    expect(taskUpdates).toHaveLength(0)
    expect(transactionUpdates).toHaveLength(0)
    expect(stripeConstructor).not.toHaveBeenCalled()
    expect(fireWebhooks).not.toHaveBeenCalled()
    expect(recordAffiliateEarning).not.toHaveBeenCalled()
    expect(rpcCalls).toHaveLength(0)
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
  it('captures a funded card payment, records both stripe_charge_id and stripe_transfer_id, and releases it — all in one approval', async () => {
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
    // Identity is recorded from the POST-capture PaymentIntent/Charge,
    // BEFORE finalize_funded_task — see approve.ts's own comment on why a
    // failure in between must never be reported as "capture failed".
    expect(rpcCalls).toEqual([
      { name: 'record_payment_charge_identity', args: {
        p_transaction_id: 'tx-1', p_stripe_payment_intent_id: 'pi_test',
        p_stripe_charge_id: 'ch_test', p_stripe_transfer_id: 'tr_test',
      } },
      { name: 'finalize_funded_task', args: {
        p_task_id: TASK_ID, p_transaction_id: 'tx-1', p_reason: 'buyer_approved',
      } },
    ])
    expect(transactionRow.stripe_charge_id).toBe('ch_test')
    expect(transactionRow.stripe_transfer_id).toBe('tr_test')
    expect(taskUpdates).toHaveLength(0)
    expect(transactionUpdates).toHaveLength(0)
    expect(fireWebhooks).toHaveBeenCalled()
  })

  it('does not publish completion side effects when capture succeeds but atomic DB finalization fails', async () => {
    transactionRow = {
      id: 'tx-1', task_id: TASK_ID, escrow_status: 'held', platform_fee_eur: 5,
      agent_payout_eur: 90, stripe_payment_intent_id: 'pi_test',
    }
    finalizeRpcError = { code: 'XX000', message: 'simulated rollback' }
    const response = await PUT(approveRequest(), { params: { id: TASK_ID } })
    expect(response.status).toBe(500)
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1)
    expect(fireWebhooks).not.toHaveBeenCalled()
    expect(recordAffiliateEarning).not.toHaveBeenCalled()
    expect(taskUpdates).toHaveLength(0)
    expect(transactionUpdates).toHaveLength(0)
  })

  it('a DB failure recording charge/transfer identity right after a successful capture is reported accurately (not as "capture failed") and never reaches finalize_funded_task — a retry heals it without a second capture', async () => {
    transactionRow = {
      id: 'tx-1', task_id: TASK_ID, escrow_status: 'held', platform_fee_eur: 5,
      agent_payout_eur: 90, stripe_payment_intent_id: 'pi_test',
    }
    identityRpcError = { code: 'XX000', message: 'simulated connection reset' }

    const first = await PUT(approveRequest(), { params: { id: TASK_ID } })
    const firstBody = await first.json()
    expect(first.status).toBe(500)
    expect(firstBody.error).toMatch(/charge\/transfer identity/i)
    expect(firstBody.error).not.toMatch(/capture failed/i) // Stripe DID capture — must not say otherwise
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1)
    expect(rpcCalls.some((c) => c.name === 'finalize_funded_task')).toBe(false)
    expect(fireWebhooks).not.toHaveBeenCalled()

    // Retry: the PaymentIntent is already 'succeeded' (capturePaymentIntent
    // call count would show a second attempt if the route mistakenly
    // re-captured), identity recording now succeeds, and finalization
    // proceeds normally.
    identityRpcError = null
    const retry = await PUT(approveRequest(), { params: { id: TASK_ID } })
    expect(retry.status).toBe(200)
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1) // still just once — never a second capture
    expect(transactionRow.stripe_charge_id).toBe('ch_test')
    expect(transactionRow.stripe_transfer_id).toBe('tr_test')
    expect(rpcCalls.some((c) => c.name === 'finalize_funded_task')).toBe(true)
  })

  it('includes the real agent_id in the public task.completed webhook payload for a public agent', async () => {
    transactionRow = {
      id: 'tx-1',
      task_id: TASK_ID,
      escrow_status: 'held',
      platform_fee_eur: 5,
      agent_payout_eur: 90,
      stripe_payment_intent_id: 'pi_test',
    }

    await PUT(approveRequest(), { params: { id: TASK_ID } })

    expect(fireWebhooks).toHaveBeenCalledWith('task.completed', expect.objectContaining({ agent_id: ASSIGNED_AGENT_ID }))
  })

  it('never puts a private agent\'s UUID or agent_id in the public task.completed webhook payload', async () => {
    assignedAgentVisibility = 'private'
    transactionRow = {
      id: 'tx-1',
      task_id: TASK_ID,
      escrow_status: 'held',
      platform_fee_eur: 5,
      agent_payout_eur: 90,
      stripe_payment_intent_id: 'pi_test',
    }

    await PUT(approveRequest(), { params: { id: TASK_ID } })

    expect(fireWebhooks).toHaveBeenCalledTimes(1)
    const payload = fireWebhooks.mock.calls[0][1]
    expect(payload).not.toHaveProperty('agent_id')
    expect(payload).toMatchObject({ agent_private: true })
    expect(JSON.stringify(payload)).not.toContain(ASSIGNED_AGENT_ID)
  })
})
