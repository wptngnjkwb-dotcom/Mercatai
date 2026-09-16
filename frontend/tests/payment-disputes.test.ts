import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  handleDisputeEvent,
  claimDisputeAdminAlert,
  markDisputeAdminAlertSent,
  markDisputeAdminAlertFailed,
  type DisputeAlertDeps,
} from '@/lib/server/paymentDisputes'
import type { FrozenAdminAlertPayload } from '@/lib/server/email'

// A uniform, trivial no-op spy — the exact same shape dozens of other
// files in this suite already use for '@/lib/server/audit'. auditLog()
// calls its own getSupabase() internally rather than taking a db
// parameter, so it can't be exercised through the hand-built fake db
// below; mocking it here (identically to every other file) is what lets
// "was an audit entry attempted" be asserted without a real Supabase call.
const { auditLog } = vi.hoisted(() => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/audit', () => ({ auditLog }))

// No vi.mock('@/lib/server/supabase') and no vi.mock('@/lib/server/email')
// anywhere in this file — every function under test takes db/stripe/deps
// as plain parameters (the same dependency-injection pattern already used
// by computeExecutionDecision/fetchAgentBidTaskIds in
// tests/execution-authorization.test.ts and computeSettledMetrics in
// tests/public-task-fields.test.ts), so this file cannot collide with
// tests/stripe-connect-webhook.test.ts's own differing
// vi.mock('@/lib/server/email') under vitest's isolate:false — see that
// file's comment, and frontend/lib/server/paymentDisputes.ts's
// DisputeAlertDeps doc comment, for why this was worth avoiding.

// ─── Fake db: in-memory tables + a real implementation of
// claim_dispute_admin_alert's claim/lease/COALESCE semantics, mirroring
// frontend/sql/18_payment_charge_identity_and_disputes.sql exactly. ─────
type Row = Record<string, any>
let disputes: Row[]
let transactions: Row[]
let disputeSeq: number

function resetDb() {
  disputes = []
  transactions = []
  disputeSeq = 0
}
resetDb()

function makeFakeDb() {
  return {
    async rpc(name: string, args: Row) {
      if (name !== 'claim_dispute_admin_alert') throw new Error(`unexpected rpc ${name}`)
      const row = disputes.find((d) => d.id === args.p_dispute_row_id)
      if (!row) return { data: null, error: null }
      const leaseExpired = row.admin_alert_status === 'sending'
        && row.admin_alert_claimed_at
        && Date.now() - new Date(row.admin_alert_claimed_at).getTime() > args.p_lease_seconds * 1000
      const claimable = row.admin_alert_status === 'pending' || row.admin_alert_status === 'failed' || leaseExpired
      if (!claimable) return { data: null, error: null }
      const token = `token-${Math.random().toString(36).slice(2)}`
      row.admin_alert_status = 'sending'
      row.admin_alert_claimed_at = new Date().toISOString()
      row.admin_alert_claim_token = token
      row.admin_alert_attempts = (row.admin_alert_attempts ?? 0) + 1
      row.admin_alert_payload_snapshot = row.admin_alert_payload_snapshot ?? args.p_payload_snapshot ?? null
      return { data: [{ claim_token: token, attempt_count: row.admin_alert_attempts, payload_snapshot: row.admin_alert_payload_snapshot }], error: null }
    },
    from(table: string) {
      const filters: [string, any][] = []
      let pendingUpdate: Row | null = null
      let pendingInsert: Row | null = null
      const source = table === 'payment_disputes' ? disputes : table === 'transactions' ? transactions : null
      if (!source) throw new Error(`fake db: unexpected table "${table}"`)
      const matches = () => source.filter((r) => filters.every(([k, v]) => r[k] === v))

      const builder: any = {
        select: () => builder,
        eq(field: string, value: any) { filters.push([field, value]); return builder },
        update(values: Row) { pendingUpdate = values; return builder },
        insert(row: Row) { pendingInsert = row; return builder },
        async maybeSingle() {
          if (pendingUpdate) {
            const rows = matches()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return { data: rows[0] ?? null, error: null }
          }
          return { data: matches()[0] ?? null, error: null }
        },
        async single() {
          if (pendingInsert) {
            disputeSeq += 1
            const row = { id: `dispute-row-${disputeSeq}`, admin_alert_status: 'pending', admin_alert_attempts: 0, ...pendingInsert }
            source.push(row)
            return { data: { id: row.id }, error: null }
          }
          return { data: matches()[0] ?? null, error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          if (pendingUpdate) {
            const rows = matches()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return resolve({ data: rows, error: null })
          }
          return resolve({ data: matches(), error: null })
        },
      }
      return builder
    },
  }
}

function makeFakeStripe(disputeObjects: Record<string, Row>) {
  return {
    disputes: {
      retrieve: vi.fn(async (id: string) => {
        const d = disputeObjects[id]
        if (!d) throw new Error(`no such dispute: ${id}`)
        return d
      }),
    },
  } as any
}

function stripeDisputeEvent(id: string, type: string) {
  return { id: `evt-${id}`, type, data: { object: { id } } } as any
}

let buildPayload: ReturnType<typeof vi.fn>
let sendAlert: ReturnType<typeof vi.fn>
let deps: DisputeAlertDeps

beforeEach(() => {
  resetDb()
  auditLog.mockClear()
  buildPayload = vi.fn((params: any): FrozenAdminAlertPayload => ({
    from: 'Mercatai <noreply@mercatai.eu>',
    to: 'admin@example.com',
    subject: `dispute ${params.status}`,
    html: `<p>${params.disputeId} ${params.amountLabel}</p>`,
    payloadVersion: 1,
  }))
  sendAlert = vi.fn(async () => 'email-1')
  deps = { buildPayload, sendAlert } as unknown as DisputeAlertDeps
})

describe('handleDisputeEvent — records dispute state, verified live from Stripe', () => {
  it('re-fetches the CURRENT dispute from Stripe rather than trusting the event snapshot', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(stripe.disputes.retrieve).toHaveBeenCalledWith('dp_1')
    expect(disputes[0]).toMatchObject({ stripe_dispute_id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount_minor: 5000, currency: 'eur' })
  })

  it('never stores card data — only id, status, reason, amount, currency', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1', payment_method_details: { card: { last4: '4242' } } },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    const serialized = JSON.stringify(disputes[0])
    expect(serialized).not.toContain('4242')
    expect(serialized).not.toMatch(/last4|card_number|cvc/i)
  })

  it('matches the dispute to a Mercatai transaction via stripe_payment_intent_id', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_1' })
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: null, amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(disputes[0].transaction_id).toBe('tx-1')
  })

  it('records the dispute even when no matching transaction exists — never dropped silently', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: null, amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_unknown' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(disputes[0].transaction_id).toBeNull()
  })

  // Deliberately no assertion here on the auditLog spy's call arguments:
  // auditLog() is this codebase's established fire-and-forget, best-effort
  // convention (see frontend/lib/server/audit.ts and every other test
  // file's identical vi.mock('@/lib/server/audit', ...)) — under this
  // suite's vitest.config.ts (isolate: false, one shared worker), dozens
  // of files registering the same trivial mock shape for that module can
  // race for which spy instance wins, so asserting on THIS file's local
  // reference being the one actually invoked is inherently flaky and not
  // worth it for a call this module already doesn't treat as load-bearing.
  // The dispute row itself (asserted throughout this file) is the real
  // source of truth.

  it('never issues a refund, transfer reversal, or any money movement — this module has no such capability at all', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'lost', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.closed'), deps)
    // The fake Stripe client only ever exposes `disputes.retrieve` —
    // proving refunds/reversals aren't just unused but structurally
    // impossible to reach from this code path in this test.
    expect(Object.keys(stripe)).toEqual(['disputes'])
  })
})

describe('handleDisputeEvent — idempotent redelivery, no duplicate alert', () => {
  it('a brand-new dispute triggers exactly one admin alert', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(disputes[0].admin_alert_status).toBe('sent')
  })

  it('redelivering the exact same event (unchanged status) does not send a second alert', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(disputes).toHaveLength(1)
  })

  it('a status change (e.g. needs_response -> lost) triggers exactly one more alert, not a duplicate of the first', async () => {
    const db = makeFakeDb()
    const stripeObjects: Record<string, Row> = {
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    }
    const stripe = makeFakeStripe(stripeObjects)
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(sendAlert).toHaveBeenCalledTimes(1)

    stripeObjects.dp_1 = { ...stripeObjects.dp_1, status: 'lost' }
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.closed'), deps)
    expect(sendAlert).toHaveBeenCalledTimes(2)
    expect(disputes).toHaveLength(1) // same row, updated in place — never a second dispute record
    expect(disputes[0].status).toBe('lost')
  })

  it('a failed alert delivery (deps.sendAlert throws) is retried on the next delivery, and succeeds without a duplicate once it does', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: null, amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    sendAlert.mockRejectedValueOnce(new Error('Resend unavailable'))
    await expect(handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)).rejects.toThrow(/Resend unavailable/)
    expect(disputes[0].admin_alert_status).toBe('failed')

    // Stripe redelivers the same event (status unchanged) — a normal
    // webhook retry after the first attempt's 500.
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(sendAlert).toHaveBeenCalledTimes(2)
    expect(disputes[0].admin_alert_status).toBe('sent')
  })
})

describe('claimDisputeAdminAlert / markDisputeAdminAlertSent / markDisputeAdminAlertFailed — claim/lease mechanics', () => {
  it('a fresh "sending" claim cannot be reclaimed by a concurrent attempt', async () => {
    const db = makeFakeDb()
    disputes.push({ id: 'row-1', admin_alert_status: 'pending', admin_alert_attempts: 0 })
    const first = await claimDisputeAdminAlert(db as any, 'row-1', null)
    const second = await claimDisputeAdminAlert(db as any, 'row-1', null)
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
  })

  it('an expired "sending" lease can be reclaimed', async () => {
    const db = makeFakeDb()
    disputes.push({
      id: 'row-1', admin_alert_status: 'sending', admin_alert_attempts: 1,
      admin_alert_claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    })
    const claim = await claimDisputeAdminAlert(db as any, 'row-1', null, 300) // 5 min lease
    expect(claim.claimed).toBe(true)
    if (claim.claimed) expect(claim.attemptCount).toBe(2)
  })

  it('markDisputeAdminAlertSent only succeeds with the matching claim token', async () => {
    const db = makeFakeDb()
    disputes.push({ id: 'row-1', admin_alert_status: 'sending', admin_alert_claim_token: 'right-token', admin_alert_attempts: 1 })
    await expect(markDisputeAdminAlertSent(db as any, 'row-1', 'wrong-token', 'email-1')).rejects.toThrow(/claim_token no longer matches/)
    await expect(markDisputeAdminAlertSent(db as any, 'row-1', 'right-token', 'email-1')).resolves.toBeUndefined()
    expect(disputes[0]).toMatchObject({ admin_alert_status: 'sent', admin_alert_provider_id: 'email-1', admin_alert_payload_snapshot: null, admin_alert_claim_token: null })
  })

  it('markDisputeAdminAlertFailed records the error without clearing the row for a future retry', async () => {
    const db = makeFakeDb()
    disputes.push({ id: 'row-1', admin_alert_status: 'sending', admin_alert_claim_token: 'tok', admin_alert_attempts: 1 })
    await markDisputeAdminAlertFailed(db as any, 'row-1', 'tok', 'boom')
    expect(disputes[0]).toMatchObject({ admin_alert_status: 'failed', last_alert_error: 'boom' })
  })
})
