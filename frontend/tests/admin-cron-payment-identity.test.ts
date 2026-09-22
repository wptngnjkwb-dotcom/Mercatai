import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
// The real production handlers — not reimplementations of their logic.
import { PUT as adminResolve } from '@/app/api/v1/admin/resolve/[taskId]/route'
import { GET as cronReleaseEscrow } from '@/app/api/cron/release-escrow/route'

/**
 * Proves the two remaining capture-and-release paths — admin dispute
 * resolution (pay_agent) and the hourly escrow-release cron — record
 * stripe_charge_id/stripe_transfer_id exactly like buyer approve does
 * (see tests/approve-unfunded.test.ts), via the SAME shared
 * recordPaymentChargeIdentity / record_payment_charge_identity RPC.
 * Neither route had any test coverage before this file.
 */

const TASK_ID = '22222222-2222-2222-2222-222222222222'

type Row = Record<string, any>
let taskRow: Row | null
let transactionRow: Row | null
// The cron route's query joins tasks!inner(...) and filters on
// 'tasks.status' — the fake just returns this pre-built array directly
// rather than re-implementing Supabase's embedded-resource filtering.
let expiredCronRows: Row[]
const rpcCalls: { name: string; args: Row }[] = []

vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/affiliate', () => ({ recordAffiliateEarning: vi.fn(async () => {}) }))
vi.mock('@/lib/server/agentVisibility', () => ({ agentIdentityForWebhook: async () => ({ agent_id: 'agent-1' }) }))
vi.mock('@/lib/server/auth', () => ({ getTokenFromRequest: async () => ({ tier: 'admin' }) }))

const { retrievePaymentIntent, capturePaymentIntent, retrieveCharge, stripeConstructor } = vi.hoisted(() => {
  const capture = vi.fn(async () => ({}))
  const retrieve = vi.fn(async () => (
    capture.mock.calls.length > 0
      ? { id: 'pi_test', capture_method: 'manual', status: 'succeeded', latest_charge: 'ch_test' }
      : { id: 'pi_test', capture_method: 'manual', status: 'requires_capture' }
  ))
  const retrieveCharge = vi.fn(async (id: string) => ({ id, transfer: 'tr_test' }))
  return {
    retrievePaymentIntent: retrieve,
    capturePaymentIntent: capture,
    retrieveCharge,
    stripeConstructor: vi.fn(function () {
      return { paymentIntents: { retrieve, capture }, charges: { retrieve: retrieveCharge } }
    }),
  }
})
vi.mock('stripe', () => ({ default: stripeConstructor }))

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args })
      if (name === 'record_payment_charge_identity') {
        const tx = args.p_transaction_id === transactionRow?.id ? transactionRow : expiredCronRows.find((r) => r.id === args.p_transaction_id)
        if (tx) {
          tx.stripe_charge_id = args.p_stripe_charge_id
          tx.stripe_transfer_id = args.p_stripe_transfer_id
        }
        return { data: [{
          transaction_id: args.p_transaction_id,
          stripe_charge_id: args.p_stripe_charge_id, stripe_transfer_id: args.p_stripe_transfer_id,
          charge_id_written: true, transfer_id_written: true,
          charge_id_conflict: false, transfer_id_conflict: false,
        }], error: null }
      }
      if (name === 'finalize_funded_task') {
        return { data: [{
          task_status: 'completed', transaction_status: 'released',
          assigned_agent_id: 'agent-1', agent_payout_eur: 90, platform_fee_eur: 0,
          newly_completed: true,
        }], error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
    from(table: string) {
      // Admin route: tasks .select().eq().single()
      // Admin route: transactions .select().eq().order().limit().maybeSingle()
      // Cron route: transactions .select().eq().lt().eq() awaited directly
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        lt: () => builder,
        async single() {
          return { data: table === 'tasks' ? taskRow : transactionRow, error: null }
        },
        async maybeSingle() {
          return { data: table === 'transactions' ? transactionRow : null, error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          // Only the cron route awaits the chain directly (no terminal
          // single/maybeSingle call) — always against `transactions`.
          return resolve({ data: expiredCronRows, error: null })
        },
      }
      return builder
    },
  }),
}))

beforeEach(() => {
  rpcCalls.length = 0
  vi.clearAllMocks()
  taskRow = { id: TASK_ID, status: 'disputed' }
  transactionRow = { id: 'tx-1', task_id: TASK_ID, escrow_status: 'held', stripe_payment_intent_id: 'pi_test' }
  expiredCronRows = []
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  process.env.CRON_SECRET = 'cron-secret-test'
})

describe('PUT /api/v1/admin/resolve/[taskId] (pay_agent) — records charge/transfer identity', () => {
  function resolveRequest(body: Row) {
    return new NextRequest(`http://localhost/api/v1/admin/resolve/${TASK_ID}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('captures the disputed payment, records both stripe_charge_id and stripe_transfer_id, then finalizes', async () => {
    const response = await adminResolve(resolveRequest({ resolution: 'pay_agent' }), { params: { taskId: TASK_ID } })

    expect(response.status).toBe(200)
    expect(capturePaymentIntent).toHaveBeenCalledWith('pi_test', {}, {})
    expect(rpcCalls.map((c) => c.name)).toEqual(['record_payment_charge_identity', 'finalize_funded_task'])
    expect(transactionRow?.stripe_charge_id).toBe('ch_test')
    expect(transactionRow?.stripe_transfer_id).toBe('tr_test')
  })
})

describe('GET /api/cron/release-escrow — records charge/transfer identity for every auto-released transaction', () => {
  function cronRequest() {
    return new NextRequest('http://localhost/api/cron/release-escrow', {
      headers: { Authorization: 'Bearer cron-secret-test' },
    })
  }

  it('captures each expired-review card hold, records both ids, and releases it', async () => {
    const cronTx: Row = {
      id: 'tx-2', task_id: TASK_ID, escrow_status: 'held',
      stripe_payment_intent_id: 'pi_test', review_deadline_at: '2020-01-01T00:00:00.000Z',
      tasks: { status: 'review', assigned_agent_id: 'agent-1' },
    }
    expiredCronRows = [cronTx]

    const response = await cronReleaseEscrow(cronRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.released).toBe(1)
    expect(capturePaymentIntent).toHaveBeenCalledWith('pi_test', {}, {})
    expect(rpcCalls.map((c) => c.name)).toEqual(['record_payment_charge_identity', 'finalize_funded_task'])
    expect(cronTx.stripe_charge_id).toBe('ch_test')
    expect(cronTx.stripe_transfer_id).toBe('tr_test')
  })
})
