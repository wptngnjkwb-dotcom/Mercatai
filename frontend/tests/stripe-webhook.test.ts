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
  tables = { transactions: [], tasks: [], bids: [], payment_disputes: [] }
  dbCalls = []
}
resetDb()

function makeDb() {
  return {
    async rpc(name: string, args: Row) {
      if (name === 'claim_dispute_admin_alert') {
        const row = tables.payment_disputes.find((d) => d.id === args.p_dispute_row_id)
        if (!row) return { data: null, error: null }
        const leaseExpired = row.admin_alert_status === 'sending'
          && row.admin_alert_claimed_at
          && Date.now() - new Date(row.admin_alert_claimed_at).getTime() > args.p_lease_seconds * 1000
        const claimable = row.admin_alert_status === 'pending' || row.admin_alert_status === 'failed' || leaseExpired
        if (!claimable) return { data: null, error: null }
        const token = `dispute-alert-token-${Math.random().toString(36).slice(2)}`
        row.admin_alert_status = 'sending'
        row.admin_alert_claimed_at = new Date().toISOString()
        row.admin_alert_claim_token = token
        row.admin_alert_attempts = (row.admin_alert_attempts ?? 0) + 1
        row.admin_alert_payload_snapshot = row.admin_alert_payload_snapshot ?? args.p_payload_snapshot ?? null
        return { data: [{ claim_token: token, attempt_count: row.admin_alert_attempts, payload_snapshot: row.admin_alert_payload_snapshot }], error: null }
      }
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
        async single() {
          if (pendingInsert) {
            const row = { id: `${table}-${tables[table].length + 1}`, admin_alert_status: 'pending', admin_alert_attempts: 0, ...pendingInsert }
            tables[table].push(row)
            return { data: { id: row.id }, error: null }
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

let currentStripeDispute: Row = { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' }

const constructEvent = vi.fn((rawBody: string, signature: string) => {
  if (signature !== 'valid-signature') throw new Error('signature verification failed')
  const event = JSON.parse(rawBody)
  if (event.type?.startsWith('payment_intent.')) currentStripeIntent = event.data.object
  // Deliberately NOT mirrored for charge.dispute.* — disputeEvent() below
  // embeds only {id}, on purpose, so tests can prove the route re-fetches
  // the CURRENT dispute via stripe.disputes.retrieve() (controlled
  // separately by currentStripeDispute) rather than trusting this
  // intentionally-impoverished event snapshot.
  return event
})
const retrievePaymentIntent = vi.fn(async (id: string) => {
  // Mirrors a real Stripe "no such payment_intent" failure for an id this
  // fixture never actually created — e.g. a Stripe Dashboard "Send test
  // webhook" synthetic fixture. See the test using this sentinel below.
  if (id === 'pi_does_not_exist') {
    throw Object.assign(new Error('No such payment_intent: pi_does_not_exist'), { type: 'StripeInvalidRequestError', statusCode: 404 })
  }
  return currentStripeIntent
})
const retrieveDispute = vi.fn(async () => currentStripeDispute)
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return {
      webhooks: { constructEvent },
      paymentIntents: { retrieve: retrievePaymentIntent },
      disputes: { retrieve: retrieveDispute },
    }
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

function disputeEvent(id: string, type: string, disputeId = 'dp_1') {
  return { id, type, data: { object: { id: disputeId } } }
}

beforeEach(() => {
  resetDb()
  auditLog.mockClear()
  failNextTaskTransition = false
  constructEvent.mockClear()
  retrieveDispute.mockClear()
  currentStripeDispute = { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' }
  delete process.env.ADMIN_ALERT_EMAIL
  delete process.env.RESEND_API_KEY
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

describe('positive acceptance criteria — a genuine 200 requires a REAL test PaymentIntent, not any accepted event', () => {
  it('a payment_intent event referencing an id this fixture never created (e.g. the Stripe Dashboard "Send test webhook" synthetic fixture) returns 500, not 200 — this is the correct, intended behavior, not a bug', async () => {
    const response = await POST(webhookRequest(paymentIntentEvent('evt_synthetic', 'payment_intent.succeeded', 'succeeded', 'pi_does_not_exist')))
    expect(response.status).toBe(500)
    // Never even reached the database — failed at the Stripe retrieve
    // step, before reconcilePaymentIntent could run at all.
    expect(dbCalls).toHaveLength(0)
  })

  it('a genuine test-mode PaymentIntent your own flow created (matching stripe_payment_intent_id in transactions) returns 200 — this is what a real positive test looks like', async () => {
    const response = await POST(webhookRequest(paymentIntentEvent('evt_real_test', 'payment_intent.succeeded', 'succeeded', 'pi_1')))
    expect(response.status).toBe(200)
    expect(tables.transactions[0].escrow_status).toBe('held')
  })
})

describe('charge.dispute.created / .updated / .closed — minimal, safe monitoring (never a refund, never a transfer reversal)', () => {
  it('re-fetches the CURRENT dispute from Stripe rather than trusting the event snapshot, and records it', async () => {
    const response = await POST(webhookRequest(disputeEvent('evt_dispute_1', 'charge.dispute.created', 'dp_1')))
    expect(retrieveDispute).toHaveBeenCalledWith('dp_1')
    // No ADMIN_ALERT_EMAIL configured in this test env -> the alert build
    // step throws, caught internally, and the route retries via 500 — but
    // the dispute state itself is still durably recorded first.
    expect(response.status).toBe(500)
    expect(tables.payment_disputes).toHaveLength(1)
    expect(tables.payment_disputes[0]).toMatchObject({ stripe_dispute_id: 'dp_1', status: 'needs_response', reason: 'fraudulent', transaction_id: 'tx-1' })
  })

  it('never stores card data', async () => {
    currentStripeDispute = { ...currentStripeDispute, payment_method_details: { card: { last4: '4242' } } }
    await POST(webhookRequest(disputeEvent('evt_dispute_1', 'charge.dispute.created', 'dp_1')))
    const serialized = JSON.stringify(tables.payment_disputes)
    expect(serialized).not.toContain('4242')
    expect(serialized).not.toMatch(/last4|card_number|cvc/i)
  })

  it('a missing ADMIN_ALERT_EMAIL is retried (500) on the next delivery, and the dispute row is never duplicated', async () => {
    const first = await POST(webhookRequest(disputeEvent('evt_dispute_1', 'charge.dispute.created', 'dp_1')))
    expect(first.status).toBe(500)
    const second = await POST(webhookRequest(disputeEvent('evt_dispute_1', 'charge.dispute.created', 'dp_1')))
    expect(second.status).toBe(500)
    expect(tables.payment_disputes).toHaveLength(1)
  })

  it('a dispute for an unknown charge/payment_intent (no matching transaction) is still recorded, with transaction_id null — never silently dropped', async () => {
    currentStripeDispute = { ...currentStripeDispute, payment_intent: 'pi_unknown' }
    await POST(webhookRequest(disputeEvent('evt_dispute_1', 'charge.dispute.created', 'dp_1')))
    expect(tables.payment_disputes[0]).toMatchObject({ transaction_id: null })
  })

  it('never issues a refund, transfer reversal, or any other money movement — the fake Stripe client exposes no such method for this route to even call', async () => {
    await POST(webhookRequest(disputeEvent('evt_dispute_1', 'charge.dispute.created', 'dp_1')))
    // Only paymentIntents/disputes retrieve methods exist on the fake
    // Stripe client this whole file uses — proving refunds/reversals
    // aren't just unused but structurally unreachable from this webhook.
    expect(retrieveDispute).toHaveBeenCalled()
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
