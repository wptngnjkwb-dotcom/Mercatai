import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/payments/stripe-webhook/route'

// The production payment webhook (POST /api/v1/payments/stripe-webhook)
// had zero test coverage before this file — discovered while diagnosing
// why it answers 503 in production (STRIPE_WEBHOOK_SECRET missing there;
// see the P0 investigation). This exercises exactly what that
// investigation needs proven once the secret is configured: 503/400
// gating, real idempotent reconciliation (via the REAL
// reconcilePaymentIntent — only Supabase and Stripe's signature
// verification are mocked), and that no raw Stripe error ever reaches a
// response body.

process.env.JWT_SECRET_KEY = 'test-secret-for-stripe-webhook-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_platform_test'

type Row = Record<string, any>

let tables: Record<string, Row[]>
let dbCalls: string[]
let failNextTaskTransition = false
let currentStripeIntent: Row = { id: 'pi_1', status: 'requires_payment_method' }

function resetDb() {
  tables = { transactions: [], tasks: [], bids: [] }
  dbCalls = []
}
resetDb()

function makeDb() {
  return {
    async rpc(name: string, args: Row) {
      if (name !== 'invalidate_task_funding') throw new Error(`unexpected rpc ${name}`)
      const tx = tables.transactions.find((row) => row.id === args.p_transaction_id)
      const task = tables.tasks.find((row) => row.id === args.p_task_id)
      if (!tx || !task) return { data: null, error: { code: 'P0002' } }
      tx.escrow_status = 'failed'
      if (task.status === 'review') task.status = 'disputed'
      else if (task.status === 'in_progress' || task.status === 'assigned') {
        task.status = 'assigned'
        task.delivery_deadline_at = null
      }
      return { data: [{ task_status: task.status, transaction_status: 'failed' }], error: null }
    },
    from(table: string) {
      dbCalls.push(table)
      if (!(table in tables)) throw new Error(`test mock: table "${table}" was never initialized`)
      const filters: [string, any][] = []
      let pendingUpdate: Row | null = null
      let pendingInsert: Row | null = null

      const rowsMatchingFilters = () => tables[table].filter((r) => filters.every(([k, v]) => r[k] === v))

      const builder: any = {
        select: () => builder,
        eq(field: string, value: any) {
          filters.push([field, value])
          return builder
        },
        update(values: Row) {
          pendingUpdate = values
          return builder
        },
        order: () => builder,
        limit: () => builder,
        insert(row: Row) {
          pendingInsert = row
          return builder
        },
        async maybeSingle() {
          if (pendingUpdate) {
            if (table === 'tasks' && pendingUpdate.status === 'in_progress' && failNextTaskTransition) {
              failNextTaskTransition = false
              return { data: null, error: new Error('simulated task update failure') }
            }
            const rows = rowsMatchingFilters()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return { data: rows[0] ?? null, error: null }
          }
          const rows = rowsMatchingFilters()
          return { data: rows[0] ?? null, error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          if (pendingUpdate) {
            const rows = rowsMatchingFilters()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return resolve({ data: rows, error: null })
          }
          if (pendingInsert) {
            tables[table].push({ id: `${table}-${tables[table].length + 1}`, ...pendingInsert })
            return resolve({ data: null, error: null })
          }
          return resolve({ data: rowsMatchingFilters(), error: null })
        },
      }
      return builder
    },
  }
}

vi.mock('@/lib/server/supabase', () => ({ getSupabase: () => makeDb() }))

const constructEvent = vi.fn((rawBody: string, signature: string) => {
  if (signature !== 'valid-signature') throw new Error('signature verification failed')
  const event = JSON.parse(rawBody)
  if (event.type?.startsWith('payment_intent.')) currentStripeIntent = event.data.object
  return event
})
const retrievePaymentIntent = vi.fn(async () => currentStripeIntent)
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return { webhooks: { constructEvent }, paymentIntents: { retrieve: retrievePaymentIntent } }
  }),
}))

// Mocked explicitly (rather than relying on the real auditLog -> getSupabase
// chain writing into the fake `audit_logs` table) because other test files
// in this isolate:false suite already mock '@/lib/server/audit' globally as
// a no-op — with a shared module registry, whichever file's mock factory
// registers first for this path wins for every file, so asserting against
// a real write here would be flaky depending on file execution order. This
// spy is controlled entirely by this file instead.
const { auditLog } = vi.hoisted(() => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/audit', () => ({ auditLog }))

function webhookRequest(event: unknown, signature = 'valid-signature') {
  return new NextRequest('http://localhost/api/v1/payments/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: JSON.stringify(event),
  })
}

function paymentIntentEvent(id: string, type: string, status: string, paymentIntentId = 'pi_1') {
  return { id, type, data: { object: { id: paymentIntentId, status } } }
}

beforeEach(() => {
  resetDb()
  auditLog.mockClear()
  failNextTaskTransition = false
  constructEvent.mockClear()
  tables.transactions.push({ id: 'tx-1', task_id: 'task-1', agent_id: 'agent-1', buyer_org_id: 'org-1', escrow_status: 'pending', stripe_payment_intent_id: 'pi_1' })
  tables.tasks.push({
    id: 'task-1', status: 'assigned', delivery_deadline_at: null,
    assigned_agent_id: 'agent-1', posted_by_org_id: 'org-1', archived_at: null,
    moderation_status: 'approved', organizations: { is_platform_seed: false },
  })
  tables.bids.push({ id: 'bid-1', task_id: 'task-1', status: 'accepted', delivery_hours: 36, submitted_at: '2026-09-01T00:00:00.000Z' })
})

describe('POST /api/v1/payments/stripe-webhook — configuration and signature', () => {
  it('returns 503 when STRIPE_WEBHOOK_SECRET is not set', async () => {
    const original = process.env.STRIPE_WEBHOOK_SECRET
    delete process.env.STRIPE_WEBHOOK_SECRET
    try {
      const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded')))
      expect(response.status).toBe(503)
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = original
    }
  })

  it('returns 503 when STRIPE_SECRET_KEY is not set', async () => {
    const original = process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_SECRET_KEY
    try {
      const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded')))
      expect(response.status).toBe(503)
    } finally {
      process.env.STRIPE_SECRET_KEY = original
    }
  })

  it('returns 400 on an invalid signature, without touching the database', async () => {
    const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded'), 'wrong-signature'))
    expect(response.status).toBe(400)
    expect(dbCalls).toHaveLength(0)
  })

  it('never leaks a raw Stripe error, a secret, or the API key in the response body', async () => {
    const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded'), 'wrong-signature'))
    const body = await response.json()
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('sk_test_dummy')
    expect(serialized).not.toContain('whsec_platform_test')
    expect(serialized).not.toContain('signature verification failed') // the raw Error message from constructEvent
  })
})

describe('payment_intent.succeeded / payment_intent.payment_failed — correct transaction state', () => {
  it('payment_intent.succeeded (requires_capture or succeeded) moves a pending transaction to held and the task to in_progress', async () => {
    const startedAt = Date.now()
    const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded')))
    expect(response.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('held')
    expect(tables.tasks[0].status).toBe('in_progress')
    const deadline = new Date(tables.tasks[0].delivery_deadline_at).getTime()
    expect(deadline).toBeGreaterThanOrEqual(startedAt + 36 * 60 * 60 * 1000)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 36 * 60 * 60 * 1000)
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment_funded' }))
  })

  it('payment_intent.payment_failed moves a pending transaction to failed', async () => {
    const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.payment_failed', 'requires_payment_method')))
    expect(response.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('failed')
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment_failed' }))
  })

  it('payment_intent.canceled also moves a pending transaction to failed', async () => {
    const response = await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.canceled', 'canceled')))
    expect(response.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('failed')
  })

  it('a canceled, previously-held card stops execution and clears its deadline atomically', async () => {
    tables.transactions[0].escrow_status = 'held'
    tables.tasks[0].status = 'in_progress'
    tables.tasks[0].delivery_deadline_at = '2026-09-03T00:00:00.000Z'
    const response = await POST(webhookRequest(paymentIntentEvent('evt_cancel_held', 'payment_intent.canceled', 'canceled')))
    expect(response.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('failed')
    expect(tables.tasks[0]).toMatchObject({ status: 'assigned', delivery_deadline_at: null })
  })

  it('a non-payment_intent event is accepted (200) but reconciles nothing', async () => {
    const response = await POST(webhookRequest({ id: 'evt_1', type: 'account.updated', data: { object: {} } }))
    expect(response.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('pending')
  })
})

describe('idempotent redelivery', () => {
  it('repairs task=assigned when a prior attempt already left transaction=held', async () => {
    failNextTaskTransition = true
    const event = paymentIntentEvent('evt_repair', 'payment_intent.succeeded', 'succeeded')

    const failedAttempt = await POST(webhookRequest(event))
    expect(failedAttempt.status).toBe(500)
    expect(await failedAttempt.json()).toEqual({ error: 'Payment reconciliation failed' })
    expect(tables.transactions[0].escrow_status).toBe('held')
    expect(tables.tasks[0].status).toBe('assigned')
    expect(auditLog).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'payment_funded' }))

    const retry = await POST(webhookRequest(event))
    expect(retry.status).toBe(200)
    expect(tables.tasks[0].status).toBe('in_progress')
    expect(tables.tasks[0].delivery_deadline_at).toEqual(expect.any(String))
    expect(auditLog).toHaveBeenCalledTimes(1)
  })

  it('redelivering the exact same payment_intent.succeeded event twice only funds the transaction once', async () => {
    const event = paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded')
    const first = await POST(webhookRequest(event))
    expect(first.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('held')
    const deadlineAfterFirst = tables.tasks[0].delivery_deadline_at
    const auditCallsAfterFirst = auditLog.mock.calls.length

    const second = await POST(webhookRequest(event))
    expect(second.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('held') // unchanged, not double-applied
    expect(auditLog.mock.calls.length).toBe(auditCallsAfterFirst) // no duplicate audit entry
    expect(tables.tasks[0].delivery_deadline_at).toBe(deadlineAfterFirst)
  })

  it('a payout_failed-style redelivery after the transaction already succeeded does not flip it back to failed', async () => {
    await POST(webhookRequest(paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'succeeded')))
    expect(tables.transactions[0].escrow_status).toBe('held')

    // A stale/duplicate payment_intent.payment_failed for the same intent
    // arriving after it already succeeded. The live retrieve returns the
    // current succeeded state, so the historical event type cannot undo it.
    await POST(webhookRequest(paymentIntentEvent('evt_2', 'payment_intent.payment_failed', 'succeeded')))
    expect(tables.transactions[0].escrow_status).toBe('held')
  })
})

// Regression note: this file deliberately never imports
// stripe-connect-webhook/route.ts or stripeConnectMonitoring.ts — with
// isolate:false, cross-importing a module another test file also mocks
// differently is exactly what corrupts both (see the project's own
// testing conventions). The Connect webhook's 54 tests live entirely in
// stripe-connect-webhook.test.ts; this file only proves that touching
// nothing about the platform payment webhook (env config is separate:
// STRIPE_WEBHOOK_SECRET here vs. STRIPE_CONNECT_WEBHOOK_SECRET there) —
// the full suite (this file's tests + that file's 54, run together in
// the same `npm test`) passing is the actual non-interference proof.
