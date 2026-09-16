import type Stripe from 'stripe'
import { createHash } from 'crypto'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
// Deliberately a TYPE-ONLY import of @/lib/server/email — this module
// must never trigger a runtime (value-level) load of email.ts. The real
// buildDisputeAdminAlertProviderPayload/sendDisputeAdminAlertOrThrow are
// wired in by the caller (see DisputeAlertDeps below); the composition
// root for production is stripe-webhook/route.ts, which imports them for
// real. Under this suite's vitest.config.ts (isolate: false, one shared
// worker), any file that transitively imports the REAL email.ts risks
// racing tests/stripe-connect-webhook.test.ts's own, differing
// vi.mock('@/lib/server/email', ...) for the same module path — a
// type-only import is erased at compile time and never touches the
// module registry, so tests/payment-disputes.test.ts (which imports this
// file directly) can inject plain vi.fn() spies as deps without any risk
// of that collision, however many times it's re-run in whatever order.
import type { FrozenAdminAlertPayload } from '@/lib/server/email'
import { formatMinorAmount } from '@/lib/server/currency'

type Db = ReturnType<typeof getSupabase>

const DEFAULT_LEASE_SECONDS = 300
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

/**
 * Minimal, SAFE dispute monitoring for the main payment webhook
 * (/api/v1/payments/stripe-webhook) — charge.dispute.created,
 * charge.dispute.updated, charge.dispute.closed. This module only ever
 * observes and alerts: it never issues a refund, never reverses a
 * transfer, and never pays anyone out. Any actual money movement in
 * response to a dispute remains a deliberate, separate decision made
 * through Mercatai's existing refund/release rules — not something this
 * file triggers automatically.
 *
 * Every handler re-fetches the CURRENT Dispute object directly from
 * Stripe using the event's own verified dispute id, rather than trusting
 * event.data.object — the same "never trust the embedded snapshot"
 * discipline already established for account.updated and payment_intent.*
 * elsewhere in this codebase (Stripe does not guarantee delivery order).
 *
 * Never stores card data — only the dispute id, Stripe's own status/
 * reason enum, amount, and currency, matched to a Mercatai transaction
 * via stripe_payment_intent_id where possible.
 */

/**
 * Derived from BOTH the dispute id AND a stable hash of the actually-
 * frozen payload — never the dispute id alone. A dispute id alone would
 * give the SAME key to every status the dispute ever reaches (created,
 * needs_response, lost, ...), and Resend rejects a reused key paired
 * with a different payload as invalid_idempotent_request — exactly the
 * failure a naive id-only key would cause the moment a real status
 * change tries to send its own, genuinely different, alert. Keyed off
 * the frozen `payload` (never a fresh, not-yet-frozen candidate) so
 * every retry of the SAME frozen payload computes the IDENTICAL key,
 * and any new payload (a real status change re-freezes one, see
 * upsertDisputeRow) computes a different one. Capped at 256 characters,
 * the same limit Resend enforces and buildPayoutAlertIdempotencyKey
 * already respects.
 */
export function buildDisputeAlertIdempotencyKey(disputeId: string, payload: FrozenAdminAlertPayload): string {
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ from: payload.from, to: payload.to, subject: payload.subject, html: payload.html, payloadVersion: payload.payloadVersion }))
    .digest('hex')
  const raw = `dispute-alert:${disputeId}:${payloadHash}`
  if (raw.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return raw
  // Not reachable in practice (disputeId + a fixed 64-char hex hash is
  // always far under 256 chars), but kept as the same safety net
  // buildPayoutAlertIdempotencyKey uses, for an arbitrarily long disputeId.
  const hash = createHash('sha256').update(raw).digest('hex')
  return `dispute-alert:${hash}`.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
}

interface DisputeRowFields {
  stripe_charge_id: string | null
  stripe_payment_intent_id: string | null
  transaction_id: string | null
  status: string
  reason: string | null
  amount_minor: number
  currency: string
}

/**
 * Idempotent upsert keyed on stripe_dispute_id — never touches
 * admin_alert_* (owned exclusively by claim_dispute_admin_alert /
 * markDisputeAdminAlert{Sent,Failed}). Returns the row id and whether
 * this call learned something new (a brand-new dispute, or a status that
 * actually changed) — the caller alerts only when true, so a pure
 * redelivery of an already-seen state never re-sends.
 */
async function upsertDisputeRow(db: Db, disputeId: string, fields: DisputeRowFields): Promise<{ rowId: string; statusChanged: boolean }> {
  const { data: existing, error: existingError } = await db
    .from('payment_disputes')
    .select('id, status')
    .eq('stripe_dispute_id', disputeId)
    .maybeSingle()
  if (existingError) throw existingError

  // A dispute's status can legitimately move again later (e.g.
  // needs_response -> lost) — each such transition is its own
  // alert-worthy event, so the claim/lease fields are re-armed back to
  // 'pending' whenever the status actually changes on an existing row.
  // Without this, claim_dispute_admin_alert would never reclaim a row
  // whose PRIOR alert already reached 'sent', and a later, materially
  // different status would go unalerted.
  const updateFields = (statusChanged: boolean) => ({
    ...fields,
    updated_at: new Date().toISOString(),
    // A pure redelivery of the SAME status (statusChanged=false) must
    // leave every admin_alert_* field untouched — including the ones
    // reset below — so this whole block only ever appears in the update
    // payload when statusChanged is true.
    ...(statusChanged ? {
      admin_alert_status: 'pending',
      admin_alert_claim_token: null,
      admin_alert_claimed_at: null,
      admin_alert_payload_snapshot: null,
      // Cleared too: a NEW status is a genuinely new alert, not a
      // continuation of the PRIOR status's delivery record. Leaving
      // these set from the prior status's 'sent' would let a stale
      // admin_alert_sent_at/provider_id sit next to a row that (until
      // this new alert actually sends) hasn't been sent for its CURRENT
      // status at all, and a stale last_alert_error would misattribute
      // an old failure to the new status.
      admin_alert_sent_at: null,
      admin_alert_provider_id: null,
      last_alert_error: null,
    } : {}),
  })

  if (existing) {
    const statusChanged = existing.status !== fields.status
    const { error: updateError } = await db
      .from('payment_disputes')
      .update(updateFields(statusChanged))
      .eq('id', existing.id)
    if (updateError) throw updateError
    return { rowId: existing.id, statusChanged }
  }

  const { data: inserted, error: insertError } = await db
    .from('payment_disputes')
    .insert({ stripe_dispute_id: disputeId, ...fields })
    .select('id')
    .single()
  if (!insertError) {
    return { rowId: inserted!.id, statusChanged: true } // brand new — always alert-worthy
  }
  // A concurrent delivery of the same event can race this insert —
  // stripe_dispute_id is UNIQUE, so the loser re-reads and updates
  // instead of treating a conflict as a hard failure.
  if ((insertError as { code?: string }).code !== '23505') throw insertError
  const { data: raced, error: racedError } = await db
    .from('payment_disputes')
    .select('id, status')
    .eq('stripe_dispute_id', disputeId)
    .maybeSingle()
  if (racedError) throw racedError
  if (!raced) throw insertError
  const statusChanged = raced.status !== fields.status
  const { error: updateError } = await db
    .from('payment_disputes')
    .update(updateFields(statusChanged))
    .eq('id', raced.id)
  if (updateError) throw updateError
  return { rowId: raced.id, statusChanged }
}

export type DisputeAdminAlertClaim =
  | { claimed: true; claimToken: string; attemptCount: number; payloadSnapshot: FrozenAdminAlertPayload | null }
  | { claimed: false }

/** Thin wrapper over claim_dispute_admin_alert — see frontend/sql/18_payment_charge_identity_and_disputes.sql for the atomic claim/lease/snapshot-freeze mechanics (identical shape to claim_payout_admin_alert). */
export async function claimDisputeAdminAlert(
  db: Db,
  disputeRowId: string,
  candidatePayload: FrozenAdminAlertPayload | null,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<DisputeAdminAlertClaim> {
  const { data, error } = await db.rpc('claim_dispute_admin_alert', {
    p_dispute_row_id: disputeRowId,
    p_lease_seconds: leaseSeconds,
    p_payload_snapshot: candidatePayload,
  })
  if (error) throw new Error(`Failed to claim admin-alert delivery for dispute ${disputeRowId}: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { claimed: false }
  return { claimed: true, claimToken: row.claim_token, attemptCount: row.attempt_count, payloadSnapshot: row.payload_snapshot ?? candidatePayload }
}

/** Same lease-scoping as markConnectEventCompleted / markAdminAlertSent: only the row matching id AND claim_token AND status='sending'. */
export async function markDisputeAdminAlertSent(db: Db, disputeRowId: string, claimToken: string, providerId: string): Promise<void> {
  const { data, error } = await db
    .from('payment_disputes')
    .update({
      admin_alert_status: 'sent',
      admin_alert_sent_at: new Date().toISOString(),
      admin_alert_provider_id: providerId,
      admin_alert_payload_snapshot: null,
      admin_alert_claim_token: null,
      admin_alert_claimed_at: null,
      last_alert_error: null,
    })
    .eq('id', disputeRowId)
    .eq('admin_alert_claim_token', claimToken)
    .eq('admin_alert_status', 'sending')
    .select('id')
  if (error) throw new Error(`Failed to record admin alert sent for dispute ${disputeRowId}: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(`Failed to record admin alert sent for dispute ${disputeRowId}: admin_alert_claim_token no longer matches — its lease was reclaimed by another attempt`)
  }
}

export async function markDisputeAdminAlertFailed(db: Db, disputeRowId: string, claimToken: string, lastError: string): Promise<void> {
  const { data, error } = await db
    .from('payment_disputes')
    .update({ admin_alert_status: 'failed', last_alert_error: lastError.slice(0, 500) })
    .eq('id', disputeRowId)
    .eq('admin_alert_claim_token', claimToken)
    .eq('admin_alert_status', 'sending')
    .select('id')
  if (error) throw new Error(`Failed to record admin alert failure for dispute ${disputeRowId}: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(`Failed to record admin alert failure for dispute ${disputeRowId}: admin_alert_claim_token no longer matches — its lease was reclaimed by another attempt`)
  }
}

/**
 * The two email.ts calls are injectable — like `db`/`stripe` elsewhere in
 * this codebase, they're parameters rather than fixed module-level
 * imports, specifically so a test can pass in a spy directly instead of
 * needing vi.mock('@/lib/server/email') here. That module is already
 * mocked differently by tests/stripe-connect-webhook.test.ts (its own
 * spy on the payout-alert functions); under vitest's isolate:false a
 * second, differing mock of the same module from another file risks
 * exactly the cross-file collision documented throughout this repo's
 * test suite — dependency injection sidesteps the need entirely.
 */
export interface DisputeAlertDeps {
  buildPayload: (params: {
    disputeId: string
    status: string
    reason: string | null
    amountLabel: string
    transactionId: string | null
    chargeId: string | null
  }) => FrozenAdminAlertPayload
  sendAlert: (payload: FrozenAdminAlertPayload, idempotencyKey: string) => Promise<string>
}

async function ensureDisputeAdminAlertSent(
  db: Db,
  disputeRowId: string,
  details: { disputeId: string; status: string; reason: string | null; amountMinor: number; currency: string; transactionId: string | null; chargeId: string | null },
  deps: DisputeAlertDeps
): Promise<void> {
  const { data: existingRow, error: peekError } = await db
    .from('payment_disputes')
    .select('admin_alert_payload_snapshot')
    .eq('id', disputeRowId)
    .maybeSingle()
  if (peekError) throw new Error(`Failed to check for an existing admin-alert payload for dispute ${disputeRowId}: ${peekError.message}`)

  let candidatePayload: FrozenAdminAlertPayload | null = null
  let candidateBuildError: string | null = null
  if (!existingRow?.admin_alert_payload_snapshot) {
    try {
      candidatePayload = deps.buildPayload({
        disputeId: details.disputeId,
        status: details.status,
        reason: details.reason,
        amountLabel: formatMinorAmount(details.amountMinor, details.currency),
        transactionId: details.transactionId,
        chargeId: details.chargeId,
      })
    } catch (err) {
      candidateBuildError = err instanceof Error ? err.message : 'failed to build the admin alert payload'
    }
  }

  const claim = await claimDisputeAdminAlert(db, disputeRowId, candidatePayload)
  if (!claim.claimed) return // already 'sent', or another attempt currently owns a fresh 'sending' claim

  const claimToken = claim.claimToken
  const payload = claim.payloadSnapshot

  if (!payload) {
    const message = candidateBuildError ?? 'no admin alert payload is available to send for this dispute'
    try {
      await markDisputeAdminAlertFailed(db, disputeRowId, claimToken, message)
    } catch (markErr) {
      console.error(`Additionally failed to record admin-alert failure for dispute ${disputeRowId}:`, markErr instanceof Error ? markErr.message : markErr)
    }
    throw new Error(`Admin alert delivery failed for dispute ${disputeRowId}: ${message}`)
  }

  // Keyed off `payload` — the actually-frozen snapshot every retry
  // reuses verbatim — never a fresh candidate, so this always matches
  // whatever was computed the first time this exact payload was sent.
  const idempotencyKey = buildDisputeAlertIdempotencyKey(details.disputeId, payload)
  try {
    const providerId = await deps.sendAlert(payload, idempotencyKey)
    await markDisputeAdminAlertSent(db, disputeRowId, claimToken, providerId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error sending admin alert'
    try {
      await markDisputeAdminAlertFailed(db, disputeRowId, claimToken, message)
    } catch (markErr) {
      console.error(`Additionally failed to record admin-alert failure for dispute ${disputeRowId}:`, markErr instanceof Error ? markErr.message : markErr)
    }
    throw new Error(`Admin alert delivery failed for dispute ${disputeRowId}: ${message}`)
  }
}

/**
 * Handles charge.dispute.created / .updated / .closed. Called by
 * POST /api/v1/payments/stripe-webhook — see that route for why disputes
 * belong there and not the Connect webhook: Mercatai's destination
 * charges create the Charge object on the PLATFORM's own Stripe account
 * (on_behalf_of only changes the settlement-merchant attribution, not
 * which account the Charge/Dispute lives on), so charge.dispute.* events
 * fire on the platform's own event stream.
 */
export async function handleDisputeEvent(db: Db, stripe: Stripe, event: Stripe.Event, deps: DisputeAlertDeps): Promise<void> {
  const eventDispute = event.data.object as Stripe.Dispute
  const dispute = await stripe.disputes.retrieve(eventDispute.id)

  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : (dispute.charge as Stripe.Charge | null)?.id ?? null
  const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : (dispute.payment_intent as Stripe.PaymentIntent | null)?.id ?? null

  let transactionId: string | null = null
  if (paymentIntentId) {
    const { data: tx, error: txError } = await db
      .from('transactions')
      .select('id')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle()
    if (txError) throw txError
    transactionId = tx?.id ?? null
  }

  const { rowId, statusChanged } = await upsertDisputeRow(db, dispute.id, {
    stripe_charge_id: chargeId,
    stripe_payment_intent_id: paymentIntentId,
    transaction_id: transactionId,
    status: dispute.status,
    reason: dispute.reason ?? null,
    amount_minor: dispute.amount,
    currency: dispute.currency,
  })

  // Best-effort, per this codebase's existing auditLog() convention —
  // never the sole record of a dispute (payment_disputes itself is),
  // just the standard cross-cutting activity trail.
  await auditLog({
    action: 'payment_dispute_observed',
    resource_type: 'payment_dispute',
    resource_id: rowId,
    details: { stripe_dispute_id: dispute.id, status: dispute.status, reason: dispute.reason ?? null, transaction_id: transactionId, event_type: event.type },
  })

  // Always attempted — never gated on statusChanged here. A pure
  // redelivery of an already-successfully-alerted state is a no-op
  // because claimDisputeAdminAlert itself only ever reclaims a 'pending'
  // or 'failed' row (or an expired 'sending' lease), never a 'sent' one;
  // a status change instead re-arms those same fields back to 'pending'
  // in upsertDisputeRow above. This mirrors ensureAdminAlertSent for
  // payouts, which is likewise called unconditionally on every funded
  // reconciliation and relies on its own claim semantics, not a
  // caller-side "did anything change" gate, to stay idempotent.
  await ensureDisputeAdminAlertSent(db, rowId, {
    disputeId: dispute.id,
    status: dispute.status,
    reason: dispute.reason ?? null,
    amountMinor: dispute.amount,
    currency: dispute.currency,
    transactionId,
    chargeId,
  }, deps)
}
