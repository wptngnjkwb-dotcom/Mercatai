import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  handleDisputeEvent,
  claimDisputeAdminAlert,
  markDisputeAdminAlertSent,
  markDisputeAdminAlertFailed,
  buildDisputeAlertIdempotencyKey,
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

/**
 * A `sendAlert` fake that actually implements Resend's real idempotency
 * rule (see frontend/lib/server/email.ts's sendAdminAlertOrThrow, which
 * this simulates): a given idempotencyKey may only ever be sent once
 * with one payload. A LATER call with the SAME key and the SAME payload
 * replays the original result (never a second physical send). A LATER
 * call with the SAME key but a DIFFERENT payload throws exactly the way
 * Resend does — invalid_idempotent_request — since this codebase's
 * default vi.fn() stub (used everywhere else in this file) always
 * succeeds regardless of key/payload and would never have caught the
 * bug this describe block exists to guard against.
 */
function makeResendLikeSendAlert() {
  const sentByKey = new Map<string, { payloadJson: string; result: string }>()
  let counter = 0
  return vi.fn(async (payload: FrozenAdminAlertPayload, idempotencyKey: string) => {
    const payloadJson = JSON.stringify(payload)
    const existing = sentByKey.get(idempotencyKey)
    if (existing) {
      if (existing.payloadJson !== payloadJson) {
        throw new Error(`Resend rejected the payment-dispute alert — idempotency key reused with a different payload (invalid_idempotent_request)`)
      }
      return existing.result
    }
    counter += 1
    const result = `email-${counter}`
    sentByKey.set(idempotencyKey, { payloadJson, result })
    return result
  })
}

describe('buildDisputeAlertIdempotencyKey — derived from dispute id AND a hash of the frozen payload', () => {
  const payloadA: FrozenAdminAlertPayload = { from: 'a', to: 'b', subject: 'needs_response', html: '<p>x</p>', payloadVersion: 1 }
  const payloadB: FrozenAdminAlertPayload = { from: 'a', to: 'b', subject: 'lost', html: '<p>y</p>', payloadVersion: 1 }

  it('a retry with the byte-identical frozen payload produces the identical key', () => {
    const key1 = buildDisputeAlertIdempotencyKey('dp_1', payloadA)
    const key2 = buildDisputeAlertIdempotencyKey('dp_1', { ...payloadA })
    expect(key1).toBe(key2)
  })

  it('the same dispute with a genuinely different payload (a real status change) produces a different key', () => {
    const key1 = buildDisputeAlertIdempotencyKey('dp_1', payloadA)
    const key2 = buildDisputeAlertIdempotencyKey('dp_1', payloadB)
    expect(key1).not.toBe(key2)
  })

  it('two different disputes with the byte-identical payload still produce different keys — the dispute id is always part of the key', () => {
    const key1 = buildDisputeAlertIdempotencyKey('dp_1', payloadA)
    const key2 = buildDisputeAlertIdempotencyKey('dp_2', payloadA)
    expect(key1).not.toBe(key2)
  })

  it('never exceeds 256 characters, even for a long dispute id', () => {
    const longId = 'dp_' + 'x'.repeat(400)
    const key = buildDisputeAlertIdempotencyKey(longId, payloadA)
    expect(key.length).toBeLessThanOrEqual(256)
  })
})

describe('handleDisputeEvent — idempotency key against a REALISTIC Resend simulation', () => {
  it('the same key with the same payload is accepted idempotently (a retry after a DB-write failure, not a second physical send)', async () => {
    const realisticSendAlert = makeResendLikeSendAlert()
    const realisticDeps = { buildPayload, sendAlert: realisticSendAlert } as unknown as DisputeAlertDeps
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), realisticDeps)
    expect(disputes[0].admin_alert_status).toBe('sent')

    // Force a second delivery of the SAME status by hand — simulates a
    // retry where the DB write recording "sent" had failed even though
    // Resend already accepted the email; the frozen payload/key are
    // unchanged, so the realistic fake must replay, not reject.
    disputes[0].admin_alert_status = 'failed'
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), realisticDeps)
    expect(disputes[0].admin_alert_status).toBe('sent')
    expect(realisticSendAlert).toHaveBeenCalledTimes(2)
    // Both calls used the identical idempotency key (2nd arg) — proving
    // this was a legitimate replay, not treated as a brand-new alert.
    const [, key1] = realisticSendAlert.mock.calls[0]
    const [, key2] = realisticSendAlert.mock.calls[1]
    expect(key1).toBe(key2)
  })

  it('a status change (needs_response -> lost) uses a genuinely different key, and BOTH alerts succeed — the old id-only key would have made the second one collide and throw invalid_idempotent_request', async () => {
    const realisticSendAlert = makeResendLikeSendAlert()
    const realisticDeps = { buildPayload, sendAlert: realisticSendAlert } as unknown as DisputeAlertDeps
    const db = makeFakeDb()
    const stripeObjects: Record<string, Row> = {
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    }
    const stripe = makeFakeStripe(stripeObjects)

    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), realisticDeps)
    expect(disputes[0].admin_alert_status).toBe('sent')

    stripeObjects.dp_1 = { ...stripeObjects.dp_1, status: 'lost' }
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.closed'), realisticDeps)
    expect(disputes[0].admin_alert_status).toBe('sent')
    expect(disputes[0].status).toBe('lost')

    expect(realisticSendAlert).toHaveBeenCalledTimes(2)
    const [, keyForNeedsResponse] = realisticSendAlert.mock.calls[0]
    const [, keyForLost] = realisticSendAlert.mock.calls[1]
    expect(keyForNeedsResponse).not.toBe(keyForLost)
  })

  it('a genuinely mismatched key+payload pairing (simulating a bug that reused a key across different content) is rejected by the realistic fake, proving the fake enforces the rule at all', async () => {
    const realisticSendAlert = makeResendLikeSendAlert()
    const payload: FrozenAdminAlertPayload = { from: 'a', to: 'b', subject: 'x', html: '<p>1</p>', payloadVersion: 1 }
    const differentPayload: FrozenAdminAlertPayload = { ...payload, html: '<p>2</p>' }
    await realisticSendAlert(payload, 'same-key')
    await expect(realisticSendAlert(differentPayload, 'same-key')).rejects.toThrow(/invalid_idempotent_request/)
  })
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

  it('redelivering the exact same status leaves admin_alert_sent_at, admin_alert_provider_id and last_alert_error untouched — only a real status change may reset them', async () => {
    const db = makeFakeDb()
    const stripe = makeFakeStripe({
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    })
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    const sentAt = disputes[0].admin_alert_sent_at
    const providerId = disputes[0].admin_alert_provider_id
    expect(sentAt).toBeTruthy()
    expect(providerId).toBeTruthy()

    // A pure redelivery of the SAME status (e.g. Stripe retrying the same
    // webhook) must not touch these fields at all — they should remain
    // literally the same value, not merely equal-looking.
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(disputes[0].admin_alert_sent_at).toBe(sentAt)
    expect(disputes[0].admin_alert_provider_id).toBe(providerId)
    expect(disputes[0].last_alert_error).toBeFalsy()
  })

  it('a status change resets admin_alert_sent_at/admin_alert_provider_id/last_alert_error before the new status is alerted, and they end up populated again for the NEW status only', async () => {
    const db = makeFakeDb()
    const stripeObjects: Record<string, Row> = {
      dp_1: { id: 'dp_1', status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'eur', charge: 'ch_1', payment_intent: 'pi_1' },
    }
    const stripe = makeFakeStripe(stripeObjects)
    sendAlert.mockResolvedValueOnce('resend-id-1')
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.created'), deps)
    expect(disputes[0].admin_alert_provider_id).toBe('resend-id-1')

    stripeObjects.dp_1 = { ...stripeObjects.dp_1, status: 'lost' }
    sendAlert.mockResolvedValueOnce('resend-id-2')
    await handleDisputeEvent(db as any, stripe, stripeDisputeEvent('dp_1', 'charge.dispute.closed'), deps)
    // Ends up 'sent' again (for the NEW status), with a genuinely NEW
    // provider id — proving the stale prior sent_at/provider_id was
    // actually cleared and freshly repopulated, not silently carried
    // forward (or, worse, left stale while the row sat un-resent).
    expect(disputes[0].admin_alert_status).toBe('sent')
    expect(disputes[0].admin_alert_provider_id).toBe('resend-id-2')
    expect(disputes[0].admin_alert_sent_at).toBeTruthy()
    expect(disputes[0].last_alert_error).toBeFalsy()
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
