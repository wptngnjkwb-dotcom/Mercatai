import { describe, expect, it, vi, beforeEach } from 'vitest'
import { recordPaymentChargeIdentity } from '@/lib/server/paymentState'

// reconcilePaymentIntent itself is NOT unit-tested here — it calls
// getSupabase() internally rather than taking `db` as a parameter, so its
// identity-backfill wiring (including the webhook-must-return-500-on-
// conflict requirement) is covered as a real integration test through the
// actual production webhook route in tests/stripe-webhook.test.ts instead,
// which already owns the one vi.mock('@/lib/server/supabase') for that
// route under this suite's isolate:false — see that file's own regression
// notes for why a second, differing mock of the same module here would
// risk exactly the cross-file collision this codebase has already hit.

/**
 * A hand-built fake db.rpc('record_payment_charge_identity', ...) that
 * mirrors frontend/sql/20_payment_charge_transfer_identity.sql's actual
 * compare-and-set logic in JS — the same style already used elsewhere in
 * this suite (see tests/payment-disputes.test.ts's makeFakeDb for
 * claim_dispute_admin_alert). No vi.mock('@/lib/server/supabase')
 * anywhere in this file — recordPaymentChargeIdentity takes `db` as a
 * plain parameter, so this cannot collide with any other file's differing
 * mock of that module under vitest's isolate:false.
 */
type Row = Record<string, any>
let transactions: Row[]
let auditLogs: Row[]

function resetDb() {
  transactions = []
  auditLogs = []
}
resetDb()

function makeFakeDb() {
  return {
    async rpc(name: string, args: Row) {
      if (name !== 'record_payment_charge_identity') throw new Error(`unexpected rpc ${name}`)
      const tx = transactions.find((t) => t.id === args.p_transaction_id)
      if (!tx) return { data: null, error: { message: 'transaction not found', code: 'P0002' } }
      if (tx.stripe_payment_intent_id !== args.p_stripe_payment_intent_id) {
        return { data: null, error: { message: 'payment intent does not match this transaction', code: 'P0001' } }
      }

      let chargeWritten = false
      let transferWritten = false
      let chargeConflict = false
      let transferConflict = false

      if (args.p_stripe_charge_id != null) {
        if (tx.stripe_charge_id == null) {
          tx.stripe_charge_id = args.p_stripe_charge_id
          chargeWritten = true
        } else if (tx.stripe_charge_id !== args.p_stripe_charge_id) {
          chargeConflict = true
        }
      }
      if (args.p_stripe_transfer_id != null) {
        if (tx.stripe_transfer_id == null) {
          tx.stripe_transfer_id = args.p_stripe_transfer_id
          transferWritten = true
        } else if (tx.stripe_transfer_id !== args.p_stripe_transfer_id) {
          transferConflict = true
        }
      }

      if (chargeConflict || transferConflict) {
        auditLogs.push({
          action: 'payment_identity_mismatch',
          resource_type: 'transaction',
          resource_id: tx.id,
          details: {
            stripe_payment_intent_id: args.p_stripe_payment_intent_id,
            existing_charge_id: tx.stripe_charge_id,
            candidate_charge_id: args.p_stripe_charge_id,
            charge_id_conflict: chargeConflict,
            existing_transfer_id: tx.stripe_transfer_id,
            candidate_transfer_id: args.p_stripe_transfer_id,
            transfer_id_conflict: transferConflict,
          },
        })
      }

      return {
        data: [{
          transaction_id: tx.id,
          stripe_charge_id: tx.stripe_charge_id,
          stripe_transfer_id: tx.stripe_transfer_id,
          charge_id_written: chargeWritten,
          transfer_id_written: transferWritten,
          charge_id_conflict: chargeConflict,
          transfer_id_conflict: transferConflict,
        }],
        error: null,
      }
    },
    from(table: string) {
      if (table !== 'transactions') throw new Error(`fake db: unexpected table "${table}"`)
      const filters: [string, any][] = []
      const builder: any = {
        select: () => builder,
        eq(field: string, value: any) { filters.push([field, value]); return builder },
        async maybeSingle() {
          const match = transactions.find((t) => filters.every(([k, v]) => t[k] === v))
          return { data: match ?? null, error: null }
        },
      }
      return builder
    },
  }
}

function makeIntent(overrides: Row = {}): any {
  return { id: 'pi_1', status: 'succeeded', latest_charge: 'ch_1', ...overrides }
}

function makeStripe(chargeTransferById: Record<string, string | null>) {
  return {
    charges: {
      retrieve: vi.fn(async (chargeId: string) => ({ id: chargeId, transfer: chargeTransferById[chargeId] ?? null })),
    },
  } as any
}

beforeEach(() => {
  resetDb()
})

describe('recordPaymentChargeIdentity — direct write-rule tests', () => {
  it('fills in an empty charge_id and transfer_id', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_1', stripe_charge_id: null, stripe_transfer_id: null })
    const db = makeFakeDb()
    const stripe = makeStripe({ ch_1: 'tr_1' })

    const result = await recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent(), stripe)

    expect(result).toEqual({ stripeChargeId: 'ch_1', stripeTransferId: 'tr_1' })
    expect(transactions[0].stripe_charge_id).toBe('ch_1')
    expect(transactions[0].stripe_transfer_id).toBe('tr_1')
  })

  it('treats a retry with the identical id as an idempotent success — no error, no audit entry', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_1', stripe_charge_id: 'ch_1', stripe_transfer_id: 'tr_1' })
    const db = makeFakeDb()
    const stripe = makeStripe({ ch_1: 'tr_1' })

    const result = await recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent(), stripe)

    expect(result).toEqual({ stripeChargeId: 'ch_1', stripeTransferId: 'tr_1' })
    expect(auditLogs).toHaveLength(0)
  })

  it('never overwrites an existing DIFFERENT charge or transfer id — throws, leaves the stored id untouched, and writes a safe audit entry', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_1', stripe_charge_id: 'ch_original', stripe_transfer_id: 'tr_original' })
    const db = makeFakeDb()
    const stripe = makeStripe({ ch_different: 'tr_different' })

    await expect(
      recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent({ latest_charge: 'ch_different' }), stripe)
    ).rejects.toThrow(/mismatch/i)

    // The mismatch must never be silently overwritten...
    expect(transactions[0].stripe_charge_id).toBe('ch_original')
    expect(transactions[0].stripe_transfer_id).toBe('tr_original')
    // ...and must never be silently dropped either.
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0].action).toBe('payment_identity_mismatch')
    expect(auditLogs[0].details.candidate_charge_id).toBe('ch_different')
    expect(auditLogs[0].details.existing_charge_id).toBe('ch_original')
  })

  it('verifies the payment intent matches transactions.stripe_payment_intent_id before writing anything', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_the_real_one', stripe_charge_id: null, stripe_transfer_id: null })
    const db = makeFakeDb()
    const stripe = makeStripe({ ch_1: 'tr_1' })

    await expect(
      recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent({ id: 'pi_wrong' }), stripe)
    ).rejects.toThrow()
    expect(transactions[0].stripe_charge_id).toBeNull()
  })

  it('a DB error immediately after a successful Stripe capture is repaired by a plain retry — no second capture involved', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_1', stripe_charge_id: null, stripe_transfer_id: null })
    const stripe = makeStripe({ ch_1: 'tr_1' })
    const flakyDb = {
      ...makeFakeDb(),
      rpc: vi.fn(async () => ({ data: null, error: { message: 'connection reset', code: 'XX000' } })),
    }

    await expect(recordPaymentChargeIdentity(flakyDb as any, 'tx-1', makeIntent(), stripe)).rejects.toThrow(/connection reset/)
    // Nothing was written by the failed attempt (still the SAME in-memory row).
    expect(transactions[0].stripe_charge_id).toBeNull()

    // Retry against a healthy db (Stripe was never re-captured — the caller
    // routes only ever re-capture when the PaymentIntent isn't already
    // succeeded/requires_capture, which it already is here).
    const healthyDb = makeFakeDb()
    const result = await recordPaymentChargeIdentity(healthyDb as any, 'tx-1', makeIntent(), stripe)
    expect(result).toEqual({ stripeChargeId: 'ch_1', stripeTransferId: 'tr_1' })
    expect(transactions[0].stripe_charge_id).toBe('ch_1')
    expect(transactions[0].stripe_transfer_id).toBe('tr_1')
  })

  it('two concurrent recordings for the same transaction converge on one consistent result with no double effect', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_1', stripe_charge_id: null, stripe_transfer_id: null })
    const db = makeFakeDb()
    const stripe = makeStripe({ ch_1: 'tr_1' })

    // Two "concurrent" callers (e.g. a webhook redelivery racing a buyer's
    // status-check poll) observing the SAME real Stripe object. The fake
    // rpc's critical section has no internal await, mirroring the atomic
    // FOR UPDATE row lock the real SQL function takes — exactly the
    // property under test: no lost update, no double write, no thrown
    // false-conflict between two callers who agree on the truth.
    const [a, b] = await Promise.all([
      recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent(), stripe),
      recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent(), stripe),
    ])

    expect(a).toEqual({ stripeChargeId: 'ch_1', stripeTransferId: 'tr_1' })
    expect(b).toEqual({ stripeChargeId: 'ch_1', stripeTransferId: 'tr_1' })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].stripe_charge_id).toBe('ch_1')
    expect(transactions[0].stripe_transfer_id).toBe('tr_1')
    expect(auditLogs).toHaveLength(0)
  })

  it('preserves the correct identity for a SEPA charge (Stripe "py_" object id, not "ch_")', async () => {
    transactions.push({ id: 'tx-1', stripe_payment_intent_id: 'pi_sepa', stripe_charge_id: null, stripe_transfer_id: null })
    const db = makeFakeDb()
    const stripe = makeStripe({ py_sepa_1: 'tr_sepa_1' })

    const result = await recordPaymentChargeIdentity(
      db as any, 'tx-1', makeIntent({ id: 'pi_sepa', latest_charge: 'py_sepa_1' }), stripe
    )

    expect(result).toEqual({ stripeChargeId: 'py_sepa_1', stripeTransferId: 'tr_sepa_1' })
  })

  it('returns null and calls neither Stripe nor the db when the intent has no charge at all', async () => {
    const db = makeFakeDb()
    const rpcSpy = vi.spyOn(db, 'rpc')
    const stripe = makeStripe({})

    const result = await recordPaymentChargeIdentity(db as any, 'tx-1', makeIntent({ latest_charge: null }), stripe)

    expect(result).toBeNull()
    expect(rpcSpy).not.toHaveBeenCalled()
    expect(stripe.charges.retrieve).not.toHaveBeenCalled()
  })
})
