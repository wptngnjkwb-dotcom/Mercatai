import type Stripe from 'stripe'
import { createHash } from 'crypto'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { computeStripeAccountReadiness, syncOnboardingCompletedFlag } from '@/lib/server/stripeAccountReadiness'
import {
  sendPayoutFailedAdminAlertOrThrow,
  sendPayoutFailedAgentNotice,
  buildAdminAlertProviderPayload,
  type FrozenAdminAlertPayload,
} from '@/lib/server/email'
import { minorUnitExponent, formatMinorAmount } from '@/lib/server/currency'
import {
  LEGACY_EXPRESS_PLATFORM_LIABILITY,
  STANDARD_AGENT_LIABILITY,
  stripeAccountFields,
  type StripeAccountRequirement,
} from '@/lib/server/stripeAccountRequirement'

type Db = ReturnType<typeof getSupabase>

const DEFAULT_LEASE_SECONDS = 300

type ConnectedAccountAgent = {
  id: string
  owner_email?: string | null
  stripe_account_id?: string | null
  stripe_onboarding_completed?: boolean | null
  stripe_standard_account_id?: string | null
  stripe_standard_onboarding_completed?: boolean | null
}

async function findAgentByConnectedAccount(
  db: Db,
  stripeAccountId: string,
): Promise<{ agent: ConnectedAccountAgent | null; requirement: StripeAccountRequirement | null }> {
  const columns = 'id,owner_email,stripe_account_id,stripe_onboarding_completed,stripe_standard_account_id,stripe_standard_onboarding_completed'
  const { data: standardAgent, error: standardError } = await db
    .from('agents')
    .select(columns)
    .eq('stripe_standard_account_id', stripeAccountId)
    .maybeSingle()
  if (standardError) throw new Error(`Failed to look up Standard agent for connected account ${stripeAccountId}: ${standardError.message}`)
  if (standardAgent) return { agent: standardAgent, requirement: STANDARD_AGENT_LIABILITY }

  const { data: legacyAgent, error: legacyError } = await db
    .from('agents')
    .select(columns)
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle()
  if (legacyError) throw new Error(`Failed to look up legacy Express agent for connected account ${stripeAccountId}: ${legacyError.message}`)
  return legacyAgent
    ? { agent: legacyAgent, requirement: LEGACY_EXPRESS_PLATFORM_LIABILITY }
    : { agent: null, requirement: null }
}

export type ConnectEventClaim = { claimed: true; id: string; claimToken: string; attemptCount: number } | { claimed: false }

/**
 * Claims a Stripe Connect event for processing via the claim_stripe_connect_event
 * Postgres function — a real, atomic lease, not a permanent lock. See that
 * function (frontend/sql/14_stripe_connect_monitoring.sql) for the full
 * mechanics: a brand-new event is inserted as 'processing'; an existing
 * event is reclaimed only if it's 'failed' or its lease has expired, never
 * a fresh 'processing' or a 'completed' row. Every claim mints a new
 * claim_token — mark-completed/mark-failed must match both id AND
 * claim_token, so a worker whose lease already expired and was reclaimed
 * by someone else can never overwrite that newer attempt's result.
 */
export async function claimConnectEvent(db: Db, event: Stripe.Event, leaseSeconds = DEFAULT_LEASE_SECONDS): Promise<ConnectEventClaim> {
  const { data, error } = await db.rpc('claim_stripe_connect_event', {
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_stripe_account_id: event.account ?? null,
    p_lease_seconds: leaseSeconds,
  })
  if (error) throw new Error(`Failed to claim Stripe Connect event ${event.id}: ${error.message}`)

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { claimed: false }
  return { claimed: true, id: row.id, claimToken: row.claim_token, attemptCount: row.attempt_count }
}

/**
 * Marks a claimed event completed — but ONLY the row matching both id and
 * claim_token, and only if that update actually affected a row. Throws on
 * a database error OR on zero rows affected (the lease was reclaimed by a
 * newer attempt in the meantime), so the webhook route can never return
 * 200 to Stripe without a genuinely confirmed completion.
 */
export async function markConnectEventCompleted(db: Db, id: string, claimToken: string): Promise<void> {
  const { data, error } = await db
    .from('stripe_connect_events')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('claim_token', claimToken)
    .select('id')

  if (error) throw new Error(`Failed to mark Stripe Connect event ${id} completed: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(`Failed to mark Stripe Connect event ${id} completed: claim_token no longer matches — its lease was reclaimed by another attempt`)
  }
}

/**
 * Marks a claimed event failed, scoped to id + claim_token the same way as
 * markConnectEventCompleted, and throws on error or zero rows affected —
 * a plain try/catch around the caller's own throw is not enough, this
 * needs the real Supabase result checked. If THIS write also fails (or
 * loses the race), that is still safe: the stale-lease branch of
 * claim_stripe_connect_event lets a later delivery reclaim the row once
 * its lease expires regardless of whether this particular mark-failed
 * call succeeded.
 */
export async function markConnectEventFailed(db: Db, id: string, claimToken: string, lastError: string): Promise<void> {
  const { data, error } = await db
    .from('stripe_connect_events')
    .update({ status: 'failed', last_error: lastError.slice(0, 500) })
    .eq('id', id)
    .eq('claim_token', claimToken)
    .select('id')

  if (error) throw new Error(`Failed to mark Stripe Connect event ${id} failed: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(`Failed to mark Stripe Connect event ${id} failed: claim_token no longer matches — its lease was reclaimed by another attempt`)
  }
}

// Re-exported for backward compatibility (tests/money-minor-units.test.ts
// and others still import these from this file) — the actual
// implementation now lives in frontend/lib/server/currency.ts, a small
// dependency-free module. It was moved out of this file specifically so
// frontend/lib/server/paymentDisputes.ts (and any other module that only
// needs currency formatting) doesn't have to transitively import
// @/lib/server/email through this file just to reach it — under this
// suite's vitest.config.ts (isolate: false, one shared worker), that
// transitive import risks racing a DIFFERENT test file's own
// vi.mock('@/lib/server/email', ...) for the same module path. See
// paymentDisputes.ts's own top-of-file comment for the full reasoning.
//
// Deliberately `export ... from` (an indirect re-export), NOT
// `export { minorUnitExponent, formatMinorAmount }` on their own line —
// the latter re-exports the LOCAL import binding above and was observed
// to transpile (via this project's esbuild-based test transform) into a
// binding that reads as undefined at runtime, despite the key existing
// on the module's export object. `export ... from` doesn't have this
// failure mode.
export { minorUnitExponent, formatMinorAmount } from '@/lib/server/currency'

interface AccountReadinessSnapshot {
  charges_enabled: boolean
  payouts_enabled: boolean
  card_payments_status: string
  sepa_debit_payments_status: string
  transfers_status: string
}

/**
 * account.updated: always re-fetches the CURRENT Account directly from
 * Stripe using the verified event.account, rather than trusting
 * event.data.object — Stripe does not guarantee delivery order, and a
 * late-arriving event's embedded snapshot can be older than what is
 * already true. Fetching fresh means there is no stale snapshot to
 * accidentally apply: whichever event triggers this fetch, the fetch
 * itself always returns whatever is truly current right now.
 *
 * Readiness-regression detection reads and writes
 * stripe_connect_account_status — a reliable, critically-checked table —
 * rather than best-effort auditLog() (which swallows its own errors and
 * must never be the sole source of truth for this comparison). Keeps
 * agents.stripe_onboarding_completed in sync in both directions via the
 * shared helper, never derived from a single boolean.
 */
export async function handleAccountUpdated(db: Db, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const stripeAccountId = event.account
  if (!stripeAccountId) return

  let account: Stripe.Account
  try {
    account = await stripe.accounts.retrieve(stripeAccountId)
  } catch {
    // Never guess state from the stale event body, never leak the raw
    // Stripe error. Throwing here means the event is marked 'failed' and
    // Stripe retries the delivery.
    throw new Error(`Failed to fetch current account state for connected account ${stripeAccountId}`)
  }

  const { agent, requirement } = await findAgentByConnectedAccount(db, stripeAccountId)

  if (!agent) {
    // A real, if unusual, situation — not every connected account this
    // Stripe platform knows about necessarily has a live agent record.
    // Best-effort audit trail is fine here; there is no critical state to
    // reconcile for an account with no matching agent.
    await auditLog({
      action: 'stripe_connect_unknown_account',
      resource_type: 'stripe_account',
      details: { stripe_account_id: stripeAccountId, event_type: event.type },
    })
    return
  }

  const readiness = computeStripeAccountReadiness(account)
  const current: AccountReadinessSnapshot = {
    charges_enabled: !!account.charges_enabled,
    payouts_enabled: !!account.payouts_enabled,
    card_payments_status: readiness.cardPaymentsStatus,
    sepa_debit_payments_status: readiness.sepaDebitPaymentsStatus,
    transfers_status: readiness.transfersStatus,
  }

  const { data: prevStatus, error: prevError } = await db
    .from('stripe_connect_account_status')
    .select('charges_enabled, payouts_enabled, card_payments_status, sepa_debit_payments_status, transfers_status')
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle()
  if (prevError) throw new Error(`Failed to read prior account status for ${stripeAccountId}: ${prevError.message}`)

  if (prevStatus) {
    const regressed: string[] = []
    if (prevStatus.charges_enabled === true && !current.charges_enabled) regressed.push('charges_enabled')
    if (prevStatus.payouts_enabled === true && !current.payouts_enabled) regressed.push('payouts_enabled')
    if (prevStatus.card_payments_status === 'active' && current.card_payments_status !== 'active') regressed.push('card_payments')
    if (prevStatus.sepa_debit_payments_status === 'active' && current.sepa_debit_payments_status !== 'active') regressed.push('sepa_debit_payments')
    if (prevStatus.transfers_status === 'active' && current.transfers_status !== 'active') regressed.push('transfers')

    if (regressed.length > 0) {
      // Best-effort — the regression itself was already reliably detected
      // above using the critical table; this is only the human-readable
      // audit trail entry, not the source of truth for detection.
      await auditLog({
        action: 'stripe_connect_readiness_lost',
        resource_type: 'agent',
        resource_id: agent.id,
        details: { stripe_account_id: stripeAccountId, regressed, ...current },
      })
    }
  }

  const { error: upsertError } = await db
    .from('stripe_connect_account_status')
    .upsert({ stripe_account_id: stripeAccountId, agent_id: agent.id, ...current, updated_at: new Date().toISOString() }, { onConflict: 'stripe_account_id' })
  if (upsertError) throw new Error(`Failed to record account status for ${stripeAccountId}: ${upsertError.message}`)

  const fields = stripeAccountFields(requirement!)
  await syncOnboardingCompletedFlag(
    db,
    agent.id,
    agent[fields.onboardingCompleted],
    readiness.onboardingComplete,
    fields.onboardingCompleted
  )
}

const PAYOUT_STATUSES = new Set(['pending', 'in_transit', 'paid', 'failed', 'canceled'])

const MAX_IDEMPOTENCY_KEY_LENGTH = 256

/**
 * Deterministic Resend idempotency key for one payout's failure alert —
 * a pure function of the two fields that never change for a given payout
 * row, so every retry (however many claim attempts it takes) computes the
 * exact same key without needing to store it. Kept under Resend's 256
 * character limit; falls back to a hash in the (practically unreachable,
 * given real Stripe id lengths) case the readable form would exceed it,
 * while staying just as deterministic.
 */
export function buildPayoutAlertIdempotencyKey(stripeAccountId: string, stripePayoutId: string): string {
  const raw = `payout-failed-alert:${stripeAccountId}:${stripePayoutId}`
  if (raw.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return raw
  const hash = createHash('sha256').update(raw).digest('hex')
  return `payout-failed-alert:${hash}`.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
}

/**
 * Records a successful send — but ONLY the row matching id AND
 * admin_alert_claim_token AND admin_alert_status='sending', the same
 * lease-scoping discipline as markConnectEventCompleted. Throws on a
 * database error OR zero rows affected (the lease was reclaimed by a
 * newer attempt in the meantime), so a stale worker can never mark a
 * newer claim's alert as sent.
 *
 * Also clears admin_alert_payload_snapshot, admin_alert_claim_token, and
 * admin_alert_claimed_at back to NULL, in the SAME conditional update —
 * a 'sent' row can never be reclaimed (see claim_payout_admin_alert),
 * so none of the three serve any further purpose once delivery is
 * confirmed. This matters beyond tidiness: the snapshot's `to` field is
 * the administrator's own email address — real PII — so there is no
 * reason to keep it sitting in the database once the alert it was for
 * has actually been delivered. admin_alert_status, admin_alert_sent_at,
 * admin_alert_attempts, and admin_alert_provider_id (set here) are the
 * durable delivery record and are left untouched.
 */
export async function markAdminAlertSent(db: Db, payoutRowId: string, claimToken: string, providerId: string): Promise<void> {
  const { data, error } = await db
    .from('stripe_connect_payouts')
    .update({
      admin_alert_status: 'sent',
      admin_alert_sent_at: new Date().toISOString(),
      admin_alert_provider_id: providerId,
      admin_alert_payload_snapshot: null,
      admin_alert_claim_token: null,
      admin_alert_claimed_at: null,
      last_alert_error: null,
    })
    .eq('id', payoutRowId)
    .eq('admin_alert_claim_token', claimToken)
    .eq('admin_alert_status', 'sending')
    .select('id')
  if (error) throw new Error(`Failed to record admin alert sent for payout ${payoutRowId}: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(`Failed to record admin alert sent for payout ${payoutRowId}: admin_alert_claim_token no longer matches — its lease was reclaimed by another attempt`)
  }
}

/** Same lease-scoping as markAdminAlertSent, for the failure path. */
export async function markAdminAlertFailed(db: Db, payoutRowId: string, claimToken: string, lastError: string): Promise<void> {
  const { data, error } = await db
    .from('stripe_connect_payouts')
    .update({ admin_alert_status: 'failed', last_alert_error: lastError.slice(0, 500) })
    .eq('id', payoutRowId)
    .eq('admin_alert_claim_token', claimToken)
    .eq('admin_alert_status', 'sending')
    .select('id')
  if (error) throw new Error(`Failed to record admin alert failure for payout ${payoutRowId}: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(`Failed to record admin alert failure for payout ${payoutRowId}: admin_alert_claim_token no longer matches — its lease was reclaimed by another attempt`)
  }
}

/**
 * Atomically claims the right to (re)send the critical payout.failed admin
 * alert for one payout row, via claim_payout_admin_alert. Retryable and
 * concurrency-safe: repeated or concurrent failure events for the same
 * payout must never both send — enforced twice over. First by the DB-level
 * claim/lease itself (below). Second by Resend's own idempotency window
 * (currently 24 hours): every attempt, however many claims it takes,
 * sends the byte-identical frozen payload under the identical key (see
 * buildPayoutAlertIdempotencyKey and admin_alert_payload_snapshot), which
 * is what Resend needs to recognize a retry as a duplicate of an
 * already-accepted request rather than a new one. This makes delivery
 * at-least-once, not exactly-once: a retry outside that window (after a
 * genuinely long outage, say) can cause a second physical email, and that
 * is accepted as the safer failure mode — a critical alert an
 * administrator sees twice beats one that silently never arrives.
 *
 * The exact provider request (from/to/subject/html) is frozen into
 * admin_alert_payload_snapshot at the FIRST successful claim and reused
 * verbatim on every later retry — never re-rendered from whatever
 * ADMIN_ALERT_EMAIL, NEXT_PUBLIC_BASE_URL, or the template itself say by
 * then. Resend rejects (invalid_idempotent_request) a reused key paired
 * with a changed payload, so letting the payload drift between attempts
 * would itself be a bug, not something Resend forgives.
 *
 * If this worker wins the claim but sending fails (including a missing
 * RESEND_API_KEY, or Resend itself rejecting the request —
 * sendPayoutFailedAdminAlertOrThrow throws on all of these rather than
 * silently no-opping), admin_alert_status is set back to 'failed' and
 * this function re-throws — which the caller must propagate so the whole
 * webhook event is NOT marked completed, and Stripe retries the
 * delivery. If Resend actually accepted the email but the follow-up DB
 * write recording that fails, the same re-throw applies — a retry then
 * reuses the same key and payload, so (within Resend's idempotency
 * window) it only needs the DB write to finally succeed, not a second
 * send to go through.
 */
export type PayoutAdminAlertClaim =
  | { claimed: true; claimToken: string; attemptCount: number; payloadSnapshot: FrozenAdminAlertPayload | null }
  | { claimed: false }

/**
 * Thin wrapper over the claim_payout_admin_alert RPC — see that function
 * (frontend/sql/14_stripe_connect_monitoring.sql) for the atomic
 * claim/lease/snapshot-freeze mechanics. `candidatePayload` is only ever
 * ADOPTED when no snapshot exists yet; pass null when the caller already
 * knows (via ensureAdminAlertSent's own check) that one does, so nothing
 * is rendered or read for no reason. Exported directly so its lease
 * semantics (staleness, attempt counting, snapshot adoption) can be unit
 * tested the same way claimConnectEvent's are.
 */
export async function claimPayoutAdminAlert(
  db: Db,
  payoutRowId: string,
  candidatePayload: FrozenAdminAlertPayload | null,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<PayoutAdminAlertClaim> {
  const { data, error } = await db.rpc('claim_payout_admin_alert', {
    p_payout_row_id: payoutRowId,
    p_lease_seconds: leaseSeconds,
    p_payload_snapshot: candidatePayload,
  })
  if (error) throw new Error(`Failed to claim admin-alert delivery for payout ${payoutRowId}: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { claimed: false }
  return { claimed: true, claimToken: row.claim_token, attemptCount: row.attempt_count, payloadSnapshot: row.payload_snapshot ?? candidatePayload }
}

async function ensureAdminAlertSent(
  db: Db,
  payoutRowId: string,
  details: { payoutId: string; stripeAccountId: string; agentId: string | null; amountMinor: number; currency: string; failureCode: string | null }
): Promise<void> {
  // Cheap read-only check: has a payload already been frozen for this
  // payout? If so, this is a retry (or a concurrent attempt) — do NOT
  // read ADMIN_ALERT_EMAIL/NEXT_PUBLIC_BASE_URL or render the current
  // template just to build a candidate that would be discarded anyway.
  const { data: existingRow, error: peekError } = await db
    .from('stripe_connect_payouts')
    .select('admin_alert_payload_snapshot')
    .eq('id', payoutRowId)
    .maybeSingle()
  if (peekError) throw new Error(`Failed to check for an existing admin-alert payload for payout ${payoutRowId}: ${peekError.message}`)

  let candidatePayload: FrozenAdminAlertPayload | null = null
  let candidateBuildError: string | null = null
  if (!existingRow?.admin_alert_payload_snapshot) {
    try {
      candidatePayload = buildAdminAlertProviderPayload({
        payoutId: details.payoutId,
        stripeAccountId: details.stripeAccountId,
        agentId: details.agentId,
        amountLabel: formatMinorAmount(details.amountMinor, details.currency),
        failureCode: details.failureCode,
      })
    } catch (err) {
      candidateBuildError = err instanceof Error ? err.message : 'failed to build the admin alert payload'
    }
  }

  const claim = await claimPayoutAdminAlert(db, payoutRowId, candidatePayload)
  if (!claim.claimed) return // already 'sent', or another attempt currently owns a fresh 'sending' claim

  const claimToken = claim.claimToken
  // Always whatever the FIRST successful claim froze — never the
  // candidate this specific call just built (which is only ever used to
  // seed that first freeze, via the RPC's own COALESCE).
  const payload = claim.payloadSnapshot

  if (!payload) {
    // Nothing was ever frozen — this attempt WAS the first claim, and
    // building its candidate failed (most commonly: ADMIN_ALERT_EMAIL
    // still not configured). Record why and let a later retry try again.
    const message = candidateBuildError ?? 'no admin alert payload is available to send for this payout'
    try {
      await markAdminAlertFailed(db, payoutRowId, claimToken, message)
    } catch (markErr) {
      console.error(`Additionally failed to record admin-alert failure for payout ${payoutRowId}:`, markErr instanceof Error ? markErr.message : markErr)
    }
    throw new Error(`Admin alert delivery failed for payout ${payoutRowId}: ${message}`)
  }

  const idempotencyKey = buildPayoutAlertIdempotencyKey(details.stripeAccountId, details.payoutId)

  try {
    const providerId = await sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)
    await markAdminAlertSent(db, payoutRowId, claimToken, providerId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error sending admin alert'
    try {
      await markAdminAlertFailed(db, payoutRowId, claimToken, message)
    } catch (markErr) {
      console.error(`Additionally failed to record admin-alert failure for payout ${payoutRowId}:`, markErr instanceof Error ? markErr.message : markErr)
    }
    throw new Error(`Admin alert delivery failed for payout ${payoutRowId}: ${message}`)
  }
}

/**
 * payout.created / payout.updated / payout.paid / payout.failed: always
 * re-fetches the CURRENT Payout directly from Stripe (in the connected
 * account's context, via { stripeAccount: stripeAccountId }) rather than
 * trusting event.data.object — the same order-independence rationale as
 * handleAccountUpdated above. A late-arriving payout.created cannot
 * revert an already-'paid' or already-'failed' row, because processing
 * it re-fetches Stripe's own current truth rather than replaying its own
 * stale embedded snapshot.
 *
 * Upserts by (stripe_account_id, stripe_payout_id) so redelivery or a
 * later status transition updates one row rather than creating
 * duplicates. Never touches tasks or transactions — a single payout can
 * bundle funds from many of them, so there is no single one to update;
 * only reconcilePaymentIntent (driven by payment_intent.* events on the
 * platform-account webhook) ever changes escrow_status. The critical
 * admin alert on a transition into 'failed' is delegated to
 * ensureAdminAlertSent above (retryable, deduplicated); the agent's own
 * notice stays best-effort and is only attempted on that same transition.
 */
export async function handlePayoutEvent(db: Db, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const stripeAccountId = event.account
  if (!stripeAccountId) return
  const eventPayoutId = (event.data.object as Stripe.Payout)?.id
  if (!eventPayoutId) return

  let payout: Stripe.Payout
  try {
    payout = await stripe.payouts.retrieve(eventPayoutId, { stripeAccount: stripeAccountId })
  } catch {
    throw new Error(`Failed to fetch current payout state for ${eventPayoutId} on connected account ${stripeAccountId}`)
  }

  const status = PAYOUT_STATUSES.has(payout.status) ? payout.status : 'pending'
  const amountMinor = payout.amount
  const currency = payout.currency
  const arrivalDate = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null
  const failureCode = payout.failure_code ?? null

  const { agent } = await findAgentByConnectedAccount(db, stripeAccountId)

  const { data: existingRow, error: existingError } = await db
    .from('stripe_connect_payouts')
    .select('id, status')
    .eq('stripe_account_id', stripeAccountId)
    .eq('stripe_payout_id', payout.id)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to look up existing payout ${payout.id}: ${existingError.message}`)

  async function updateExistingPayoutRow(id: string): Promise<void> {
    const { data: updatedRows, error } = await db
      .from('stripe_connect_payouts')
      .update({
        agent_id: agent?.id ?? null,
        amount_minor: amountMinor,
        currency,
        status,
        arrival_date: arrivalDate,
        failure_code: failureCode,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id')
    if (error) throw new Error(`Failed to update payout ${payout.id}: ${error.message}`)
    if (!updatedRows || updatedRows.length === 0) throw new Error(`Failed to update payout ${payout.id}: no row matched id ${id}`)
  }

  let rowId: string
  if (existingRow) {
    await updateExistingPayoutRow(existingRow.id)
    rowId = existingRow.id
  } else {
    const { data: insertedRow, error } = await db
      .from('stripe_connect_payouts')
      .insert({
        stripe_payout_id: payout.id,
        stripe_account_id: stripeAccountId,
        agent_id: agent?.id ?? null,
        amount_minor: amountMinor,
        currency,
        status,
        arrival_date: arrivalDate,
        failure_code: failureCode,
      })
      .select('id')
      .single()

    if (error?.code === '23505') {
      // Lost a race with a concurrent event for the SAME payout that
      // inserted first (two different Stripe event ids for one payout,
      // processed by two different requests at nearly the same time) —
      // fall back to updating the row that won, rather than crashing.
      const { data: raceRow, error: raceLookupError } = await db
        .from('stripe_connect_payouts')
        .select('id')
        .eq('stripe_account_id', stripeAccountId)
        .eq('stripe_payout_id', payout.id)
        .maybeSingle()
      if (raceLookupError || !raceRow) {
        throw new Error(`Failed to record payout ${payout.id}: lost an insert race but could not find the winning row: ${raceLookupError?.message ?? 'not found'}`)
      }
      await updateExistingPayoutRow(raceRow.id)
      rowId = raceRow.id
    } else if (error || !insertedRow) {
      throw new Error(`Failed to record payout ${payout.id}: ${error?.message ?? 'no row returned'}`)
    } else {
      rowId = insertedRow.id
    }
  }

  await auditLog({
    action: `stripe_payout_${status}`,
    resource_type: 'stripe_payout',
    resource_id: rowId,
    agent_id: agent?.id,
    details: { stripe_payout_id: payout.id, stripe_account_id: stripeAccountId, amount_minor: amountMinor, currency, status, failure_code: failureCode, event_type: event.type },
  })

  if (status === 'failed') {
    // Critical, retryable, deduplicated — see ensureAdminAlertSent. A
    // thrown error here must propagate so the caller does not mark this
    // webhook event completed.
    await ensureAdminAlertSent(db, rowId, { payoutId: payout.id, stripeAccountId, agentId: agent?.id ?? null, amountMinor, currency, failureCode })
  }

  const justFailed = status === 'failed' && existingRow?.status !== 'failed'
  if (justFailed && agent?.owner_email) {
    // Best-effort and non-critical, deliberately not gated on the admin
    // alert's own success — the agent's own notice may be sent, skipped,
    // or occasionally duplicated on a redelivery without materially
    // affecting anyone; only the admin alert must be reliable.
    try {
      await sendPayoutFailedAgentNotice({ to: agent.owner_email, amountLabel: formatMinorAmount(amountMinor, currency) })
    } catch (err) {
      console.error(`Best-effort agent payout-failure notice failed for payout ${payout.id}:`, err instanceof Error ? err.message : err)
    }
  }
}

/**
 * account.external_account.updated: Stripe sends this when a connected
 * account's external bank account or card changes status — notably after
 * a payout failure marks it 'errored', which means further payouts to it
 * will keep failing until the agent fixes it in their Stripe dashboard.
 * Captures only a coarse status and account type, NEVER an account
 * number, last4, routing number, account holder name, or the raw object.
 *
 * Deliberately, explicitly best-effort: the write is a plain auditLog()
 * call, which swallows its own errors by design (see audit.ts) — unlike
 * account.updated/payout.* above, this handler does NOT check a critical
 * DB write and does NOT throw on one failing. Do not describe this event
 * as "reliably captured" anywhere (docs, commit messages, reports) —
 * only account.updated, payout.*, and the payout-failure admin alert
 * carry that guarantee.
 */
export async function handleExternalAccountUpdated(db: Db, event: Stripe.Event): Promise<void> {
  const stripeAccountId = event.account
  if (!stripeAccountId) return

  const externalAccount = event.data.object as { object?: string; status?: string }
  const safeStatus = typeof externalAccount.status === 'string' ? externalAccount.status : 'unknown'
  const externalAccountType = externalAccount.object === 'card' ? 'card' : 'bank_account'

  const { agent } = await findAgentByConnectedAccount(db, stripeAccountId)

  await auditLog({
    action: 'stripe_connect_external_account_updated',
    resource_type: 'agent',
    resource_id: agent?.id,
    details: { stripe_account_id: stripeAccountId, external_account_type: externalAccountType, status: safeStatus },
  })
}
