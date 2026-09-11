import type Stripe from 'stripe'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { computeStripeAccountReadiness, syncOnboardingCompletedFlag } from '@/lib/server/stripeAccountReadiness'
import { sendPayoutFailedAdminAlert, sendPayoutFailedAgentNotice } from '@/lib/server/email'

type Db = ReturnType<typeof getSupabase>

const POSTGRES_UNIQUE_VIOLATION = '23505'

export type ConnectEventClaim = { claimed: true; id: string } | { claimed: false }

/**
 * Claims a Stripe Connect event for processing, keyed by Stripe's own
 * event id. Stripe redelivers events on timeout or retry, and two
 * deliveries of the same event can also race each other — this makes
 * both cases resolve to exactly one processing attempt. The first INSERT
 * wins the row; any other delivery sees the unique-violation and either
 * finds the event already 'completed' (nothing left to do), still
 * 'processing' (a concurrent delivery is handling it right now), or
 * 'failed' (a previous attempt didn't finish — this delivery may retry it,
 * but only by winning its own atomic reclaim, in case yet another
 * concurrent delivery is reclaiming it at the same moment).
 *
 * Throws on a genuine database error (not a unique-violation) so the
 * caller returns 500 and Stripe retries the delivery later.
 */
export async function claimConnectEvent(db: Db, event: Stripe.Event): Promise<ConnectEventClaim> {
  const { data: inserted, error: insertError } = await db
    .from('stripe_connect_events')
    .insert({
      stripe_event_id: event.id,
      event_type: event.type,
      stripe_account_id: event.account ?? null,
      status: 'processing',
    })
    .select('id')
    .single()

  if (!insertError && inserted) return { claimed: true, id: inserted.id }

  if (insertError?.code !== POSTGRES_UNIQUE_VIOLATION) {
    throw new Error(`Failed to record Stripe Connect event ${event.id}: ${insertError?.message ?? 'unknown error'}`)
  }

  const { data: existing, error: fetchError } = await db
    .from('stripe_connect_events')
    .select('id, status')
    .eq('stripe_event_id', event.id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error(`Failed to look up existing Stripe Connect event ${event.id}: ${fetchError?.message ?? 'not found'}`)
  }

  if (existing.status !== 'failed') {
    return { claimed: false }
  }

  const { data: reclaimed } = await db
    .from('stripe_connect_events')
    .update({ status: 'processing' })
    .eq('id', existing.id)
    .eq('status', 'failed')
    .select('id')
    .maybeSingle()

  return reclaimed ? { claimed: true, id: reclaimed.id } : { claimed: false }
}

export async function markConnectEventCompleted(db: Db, id: string): Promise<void> {
  await db.from('stripe_connect_events').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id)
}

export async function markConnectEventFailed(db: Db, id: string): Promise<void> {
  try {
    await db.from('stripe_connect_events').update({ status: 'failed' }).eq('id', id)
  } catch {
    // Best-effort — if even this write fails, the row is stuck at
    // 'processing'. The next genuinely new Stripe event for this account
    // is unaffected either way; only a retry of this exact event id would
    // be (harmlessly) treated as "already being handled" rather than
    // retried immediately.
  }
}

interface AccountReadinessSnapshot {
  charges_enabled: boolean
  payouts_enabled: boolean
  card_payments_status: string
  sepa_debit_payments_status: string
  transfers_status: string
}

/**
 * account.updated: keeps agents.stripe_onboarding_completed in sync (both
 * directions, via the shared helper — never derived from a single
 * boolean), and logs a distinct 'stripe_connect_readiness_lost' audit
 * event whenever any individual gate regresses since the last snapshot —
 * not just when the aggregate onboardingComplete flag flips. An agent with
 * two active payment methods that loses one still has
 * onboardingComplete=true (it only ever requires "at least one"), but has
 * genuinely lost something Stripe previously granted, and that must not
 * go unnoticed just because the coarser flag didn't move.
 */
export async function handleAccountUpdated(db: Db, event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account
  const stripeAccountId = event.account ?? account.id
  if (!stripeAccountId) return

  const { data: agent, error: agentError } = await db
    .from('agents')
    .select('id, stripe_onboarding_completed')
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle()

  if (agentError) {
    throw new Error(`Failed to look up agent for connected account ${stripeAccountId}: ${agentError.message}`)
  }

  if (!agent) {
    // A real, if unusual, situation — not every connected account this
    // Stripe platform account knows about necessarily has a live agent
    // record (a deleted agent, or an account from before this database's
    // current state). Nothing to sync or compare against; just leave a
    // trail.
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

  const { data: lastSnapshot, error: snapshotError } = await db
    .from('audit_logs')
    .select('details')
    .eq('resource_type', 'agent')
    .eq('resource_id', agent.id)
    .eq('action', 'stripe_connect_account_snapshot')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (snapshotError) {
    throw new Error(`Failed to look up prior readiness snapshot for agent ${agent.id}: ${snapshotError.message}`)
  }

  const prev = lastSnapshot?.details as Partial<AccountReadinessSnapshot> | undefined
  if (prev) {
    const regressed: string[] = []
    if (prev.charges_enabled === true && !current.charges_enabled) regressed.push('charges_enabled')
    if (prev.payouts_enabled === true && !current.payouts_enabled) regressed.push('payouts_enabled')
    if (prev.card_payments_status === 'active' && current.card_payments_status !== 'active') regressed.push('card_payments')
    if (prev.sepa_debit_payments_status === 'active' && current.sepa_debit_payments_status !== 'active') regressed.push('sepa_debit_payments')
    if (prev.transfers_status === 'active' && current.transfers_status !== 'active') regressed.push('transfers')

    if (regressed.length > 0) {
      await auditLog({
        action: 'stripe_connect_readiness_lost',
        resource_type: 'agent',
        resource_id: agent.id,
        details: { stripe_account_id: stripeAccountId, regressed, ...current },
      })
    }
  }

  await auditLog({
    action: 'stripe_connect_account_snapshot',
    resource_type: 'agent',
    resource_id: agent.id,
    details: { ...current },
  })

  await syncOnboardingCompletedFlag(db, agent.id, agent.stripe_onboarding_completed, readiness.onboardingComplete)
}

const PAYOUT_STATUSES = new Set(['pending', 'in_transit', 'paid', 'failed', 'canceled'])

/**
 * payout.created / payout.updated / payout.paid / payout.failed: records
 * payout STATE ONLY (see stripe_connect_payouts in
 * frontend/sql/14_stripe_connect_monitoring.sql — never a bank account
 * number or account holder name), keyed on (stripe_account_id,
 * stripe_payout_id) so redelivery or a later status transition for the
 * same payout updates one row rather than creating duplicates. Never
 * touches tasks or transactions — a single payout can bundle funds from
 * many of them, so there is no single one to update; only
 * reconcilePaymentIntent (driven by payment_intent.* events on the
 * platform-account webhook) ever changes escrow_status. Alerts (admin
 * email always; the agent's own owner_email when one is on file) fire
 * only on the transition INTO 'failed', not on every redelivery of an
 * already-failed payout's events.
 */
export async function handlePayoutEvent(db: Db, event: Stripe.Event): Promise<void> {
  const payout = event.data.object as Stripe.Payout
  const stripeAccountId = event.account
  if (!stripeAccountId) return

  const status = PAYOUT_STATUSES.has(payout.status) ? payout.status : 'pending'
  const amount = payout.amount / 100
  const currency = payout.currency
  const arrivalDate = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null
  const failureCode = payout.failure_code ?? null

  const { data: agent, error: agentError } = await db
    .from('agents')
    .select('id, owner_email')
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle()

  if (agentError) {
    throw new Error(`Failed to look up agent for connected account ${stripeAccountId}: ${agentError.message}`)
  }

  const { data: existingRow, error: existingError } = await db
    .from('stripe_connect_payouts')
    .select('id, status')
    .eq('stripe_account_id', stripeAccountId)
    .eq('stripe_payout_id', payout.id)
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to look up existing payout ${payout.id}: ${existingError.message}`)
  }

  const wasAlreadyFailed = existingRow?.status === 'failed'
  let rowId: string

  if (existingRow) {
    const { error } = await db
      .from('stripe_connect_payouts')
      .update({
        agent_id: agent?.id ?? null,
        amount,
        currency,
        status,
        arrival_date: arrivalDate,
        failure_code: failureCode,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingRow.id)
    if (error) throw new Error(`Failed to update payout ${payout.id}: ${error.message}`)
    rowId = existingRow.id
  } else {
    const { data: insertedRow, error } = await db
      .from('stripe_connect_payouts')
      .insert({
        stripe_payout_id: payout.id,
        stripe_account_id: stripeAccountId,
        agent_id: agent?.id ?? null,
        amount,
        currency,
        status,
        arrival_date: arrivalDate,
        failure_code: failureCode,
      })
      .select('id')
      .single()
    if (error || !insertedRow) throw new Error(`Failed to record payout ${payout.id}: ${error?.message ?? 'no row returned'}`)
    rowId = insertedRow.id
  }

  await auditLog({
    action: `stripe_payout_${status}`,
    resource_type: 'stripe_payout',
    resource_id: rowId,
    agent_id: agent?.id,
    details: { stripe_payout_id: payout.id, stripe_account_id: stripeAccountId, amount, currency, status, failure_code: failureCode, event_type: event.type },
  })

  const justFailed = status === 'failed' && !wasAlreadyFailed
  if (justFailed) {
    await sendPayoutFailedAdminAlert({
      payoutId: payout.id,
      stripeAccountId,
      agentId: agent?.id ?? null,
      amount,
      currency,
      failureCode,
    })
    if (agent?.owner_email) {
      await sendPayoutFailedAgentNotice({ to: agent.owner_email, amount, currency })
    }
  }
}
