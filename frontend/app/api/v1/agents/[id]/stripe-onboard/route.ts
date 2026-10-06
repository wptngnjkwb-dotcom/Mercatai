import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import {
  getOnboardingCountry,
  requiredCapabilitiesForCountry,
} from '@/lib/onboardingCountries'
import { isOnboardingCountryEnabled, isPaymentCountryEnabled } from '@/lib/server/stripeConnectCountries'
import {
  computeStripeAccountReadiness,
  syncOnboardingCompletedFlag,
  classifyDisabledReason,
  disabledReasonBlockingResponse,
} from '@/lib/server/stripeAccountReadiness'
import {
  publicPaymentResponsibility,
  resolveOnboardingRequirement,
  stripeAccountFields,
  stripeAccountMatchesRequirement,
} from '@/lib/server/stripeAccountRequirement'

// Stripe's legal-entity structures for a connected account. Left unset by
// default so Stripe's hosted onboarding asks the account holder directly —
// see docs/stripe-norway-onboarding.md for why business_type must not be
// hardcoded, and must not be inferred from country either (e.g. 'individual'
// is *an available* legal form for a Norwegian account, not the one Mercatai
// should assume for every Norwegian agent).
const ALLOWED_BUSINESS_TYPES = new Set(['individual', 'company', 'non_profit', 'government_entity'])

// POST /api/v1/agents/:id/stripe-onboard
// Creates or retrieves the Stripe account required by the task. Standard is
// the fail-closed default; only the three explicitly migrated pilot tasks can
// resolve to the legacy Express/platform-liability account.
// then returns an onboarding URL for the agent to complete identity
// verification (KYC) directly with Stripe.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.tier !== 'admin' && token.agent_id !== params.id) {
    return NextResponse.json({ error: 'Forbidden — only the agent itself or an admin can manage its Stripe onboarding' }, { status: 403 })
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const body = await request.json().catch(() => ({}))
  const taskId = typeof body.task_id === 'string' && body.task_id.trim() ? body.task_id.trim() : null

  // country: ISO 3166-1 alpha-2, e.g. 'CZ', 'NO', or 'PE'. Required — no default. A
  // connected account's country is difficult to change after creation, so
  // silently defaulting a foreign agent to 'CZ' risks creating a Stripe
  // account that agent can never actually use. The caller must supply the
  // country explicitly, and it must match the actual country of the person
  // or business that will hold this payout account.
  const rawCountry = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  if (!rawCountry) {
    return NextResponse.json({
      error: 'country is required (ISO 3166-1 alpha-2, e.g. "CZ", "NO", or "PE") — it must match the actual holder of the payout account.',
    }, { status: 400 })
  }
  const countryConfig = getOnboardingCountry(rawCountry)
  if (!countryConfig) {
    return NextResponse.json({
      error: `'${rawCountry}' is not currently supported for onboarding by Mercatai. Connected-account availability depends on Stripe Connect and the selected account model, not merely on whether customers in that country can pay by card.`,
    }, { status: 400 })
  }
  const country = rawCountry

  // business_type: the connected account's legal form, e.g. 'individual' for
  // a sole proprietor or 'company' for an incorporated business. Optional —
  // when omitted, Stripe's hosted onboarding asks the agent to select it
  // directly instead of Mercatai assuming 'company' for every agent
  // regardless of country or legal form.
  const rawBusinessType = typeof body.business_type === 'string' ? body.business_type.trim().toLowerCase() : ''
  if (rawBusinessType && !ALLOWED_BUSINESS_TYPES.has(rawBusinessType)) {
    return NextResponse.json({ error: `business_type must be one of: ${Array.from(ALLOWED_BUSINESS_TYPES).join(', ')}` }, { status: 400 })
  }

  const db = getSupabase()

  const { data: agent } = await db
    .from('agents')
    .select('id, agent_id, owner_email, stripe_account_id, stripe_onboarding_completed, stripe_standard_account_id, stripe_standard_onboarding_completed')
    .eq('id', params.id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const resolved = await resolveOnboardingRequirement(db, taskId, agent.id)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const accountRequirement = resolved.requirement
  const accountFields = stripeAccountFields(accountRequirement)
  const responsibility = publicPaymentResponsibility(accountRequirement)

  // Availability differs by account model: Standard adds HR/LI but excludes
  // IS, while the three legacy Express pilots use Stripe's older Express
  // catalog. Resolve the server-owned task requirement first, then validate
  // the country against that exact model. The request body cannot choose it.
  if (!isOnboardingCountryEnabled(country, accountFields.stripeType)) {
    return NextResponse.json({
      error: `'${country}' is not currently enabled for Stripe ${accountFields.stripeType === 'standard' ? 'Standard/full-dashboard' : 'Express'} onboarding on Mercatai.`,
      ...responsibility,
    }, { status: 400 })
  }
  const requiredCapabilities = requiredCapabilitiesForCountry(country, accountFields.stripeType)
  if (!requiredCapabilities) {
    return NextResponse.json({ error: `'${country}' has no Mercatai capability profile.` }, { status: 400 })
  }

  // Registration has required and stored owner_email since this was added,
  // and the migration backfills it for pre-existing agents wherever their
  // organization's historical name was itself a valid email — but an agent
  // whose org name was never an email (it fell back to agent_id) has no
  // value to backfill from, and stays NULL. Fail with a clear, actionable
  // error here rather than send Stripe a null email and get back an
  // opaque failure from their side instead.
  if (!agent.owner_email) {
    return NextResponse.json({
      error: 'This agent has no contact email on file, which Stripe onboarding requires. Contact mercatai@seznam.cz to have it added.',
    }, { status: 400 })
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mercatai.eu'

  let stripeAccountId = agent[accountFields.accountId]
  const storedOnboardingCompleted = agent[accountFields.onboardingCompleted]

  if (stripeAccountId) {
    // An account already exists — verify its LIVE state rather than
    // trusting the stored stripe_onboarding_completed flag, and attempt a
    // remediation path for whatever is actually still missing (including
    // card_payments for an account created before that capability was
    // added here) instead of just re-issuing a link and hoping.
    let account
    try {
      account = await stripe.accounts.retrieve(stripeAccountId)
    } catch (stripeErr) {
      const message = stripeErr instanceof Error ? stripeErr.message : 'Could not retrieve the existing Stripe account'
      return NextResponse.json({ error: message, stripe_account_id: stripeAccountId }, { status: 502 })
    }

    if (!stripeAccountMatchesRequirement(account, accountRequirement)) {
      return NextResponse.json({
        error: `The stored Stripe account does not match this task's required ${accountFields.stripeType} responsibility model. Contact support; Mercatai will not silently reuse or convert it.`,
        stripe_account_id: stripeAccountId,
        ...responsibility,
      }, { status: 409 })
    }

    // A connected account's country is essentially fixed after creation —
    // if the request now names a different country than the account
    // actually holds, that account belongs to a different real-world
    // holder than the one submitting this request. Silently creating a
    // second account would leave two Stripe accounts for one agent record;
    // this needs a human to sort out instead.
    if (account.country !== country) {
      return NextResponse.json({
        error: `This agent's existing Stripe account is registered in ${account.country}, which does not match the requested country (${country}). Mercatai does not automatically create a second account for the same agent — contact support.`,
        stripe_account_id: stripeAccountId,
        existing_country: account.country,
      }, { status: 409 })
    }

    const readiness = computeStripeAccountReadiness(account)
    await syncOnboardingCompletedFlag(
      db,
      agent.id,
      storedOnboardingCompleted,
      readiness.onboardingComplete,
      accountFields.onboardingCompleted
    )

    // Some disabled_reason values (requirements.past_due,
    // action_required.requested_capabilities) are normal, self-service
    // states a fresh onboarding link resolves — only genuinely blocked or
    // Stripe-side-pending states short-circuit here. See
    // frontend/lib/server/stripeAccountReadiness.ts.
    const disabledClassification = classifyDisabledReason(account.requirements?.disabled_reason)
    const blocking = disabledReasonBlockingResponse(disabledClassification, stripeAccountId)
    if (blocking) {
      return NextResponse.json(blocking.body, { status: blocking.status })
    }

    // Checking "any capability short of active" is deliberately a stricter
    // bar than readiness.onboardingComplete on its own (which only requires
    // identity + payouts + AT LEAST ONE payment method, and gates
    // create-intent) — otherwise a legacy account that already satisfies
    // onboardingComplete via SEPA alone (created before card_payments was
    // added to the capabilities requested at account creation, below) would
    // never have card_payments requested for it. But "already completed"
    // itself must require BOTH: no capability is missing, AND
    // onboardingComplete is actually true — a capability can be active
    // while identity details, outstanding requirements, or payouts_enabled
    // still leave the account genuinely not ready, and reporting completion
    // then would be a false confirmation.
    const missingCapabilities: Record<string, { requested: true }> = {}
    if (requiredCapabilities.card_payments && readiness.cardPaymentsStatus !== 'active') {
      missingCapabilities.card_payments = { requested: true }
    }
    if (requiredCapabilities.sepa_debit_payments && readiness.sepaDebitPaymentsStatus !== 'active') {
      missingCapabilities.sepa_debit_payments = { requested: true }
    }
    // Stripe pairs `transfers` with `card_payments` at the request level
    // (see RequiredStripeCapabilities in onboardingCountries.ts) — a legacy
    // account whose transfers capability was never requested would fail the
    // remediation update below with the exact same "card_payments without
    // transfers" error accounts.create() gives a brand-new account missing it.
    if (requiredCapabilities.transfers && readiness.transfersStatus !== 'active') {
      missingCapabilities.transfers = { requested: true }
    }
    const hasMissingCapabilities = Object.keys(missingCapabilities).length > 0

    if (readiness.onboardingComplete && !hasMissingCapabilities) {
      return NextResponse.json({
        message: 'Stripe onboarding already completed',
        stripe_account_id: stripeAccountId,
        country,
        supported_payment_methods: countryConfig.supportsSepaDebit ? ['card', 'sepa_debit'] : ['card'],
        task_id: resolved.taskId,
        ...responsibility,
      })
    }

    if (hasMissingCapabilities) {
      try {
        await stripe.accounts.update(stripeAccountId, { capabilities: missingCapabilities })
      } catch (stripeErr) {
        const message = stripeErr instanceof Error ? stripeErr.message : 'Could not request the missing capabilities'
        return NextResponse.json({
          error: `Could not request this account's missing capabilities: ${message}. This may need manual review in the Stripe Dashboard.`,
          stripe_account_id: stripeAccountId,
          action_required: 'manual_stripe_dashboard_review',
        }, { status: 409 })
      }
    }
    // Fall through to issue a fresh account link below — whether because a
    // capability was just requested, or because something else (identity
    // details, outstanding requirements, payouts_enabled) still needs
    // resolving through Stripe's own hosted onboarding, with nothing left
    // here for accounts.update to request.
  } else {
    try {
      const account = await stripe.accounts.create({
        type: accountFields.stripeType,
        country,
        email: agent.owner_email,
        // Express pilot accounts pair `transfers` with `card_payments`
        // because Stripe rejects the Express request without it. Standard
        // accounts deliberately omit `transfers`; their own Dashboard and
        // Stripe responsibility model govern settlement and payouts.
        // SEPA is requested only where Stripe documents the connected
        // account's country as a supported business location.
        capabilities: requiredCapabilities,
        ...(rawBusinessType ? { business_type: rawBusinessType as any } : {}),
        metadata: {
          mercatai_agent_id: agent.agent_id,
          mercatai_db_id: agent.id,
          mercatai_account_requirement: accountRequirement,
          ...(resolved.taskId ? { mercatai_task_id: resolved.taskId } : {}),
        },
      })
      stripeAccountId = account.id
    } catch (stripeErr) {
      console.error('Stripe account creation failed:', stripeErr)
      const message = stripeErr instanceof Error ? stripeErr.message : 'Stripe account creation failed'
      return NextResponse.json({ error: message }, { status: 502 })
    }

    const { error: linkError } = await db.from('agents')
      .update({ [accountFields.accountId]: stripeAccountId })
      .eq('id', params.id)

    if (linkError) {
      // The Stripe account exists but the agent record was never linked to
      // it — a real, orphaned Stripe object. Reporting success here would
      // hand back an onboarding link for an account nothing else in
      // Mercatai can ever find again. Fail loudly and leave a trail for an
      // admin to reconcile manually instead.
      console.error('Stripe account created but failed to link to agent record — orphaned Stripe account', {
        agentDbId: params.id,
        stripeAccountId,
        dbError: linkError.message,
      })
      await auditLog({
        action: 'stripe_account_orphaned',
        resource_type: 'agent',
        resource_id: params.id,
        details: { stripe_account_id: stripeAccountId, account_requirement: accountRequirement, db_error: linkError.message },
      })
      return NextResponse.json({
        error: `Your Stripe account was created but could not be saved. Contact support with this reference: ${stripeAccountId}`,
        stripe_account_id: stripeAccountId,
      }, { status: 500 })
    }
  }

  // Short-lived, single-use — Stripe sends the agent back to refresh_url
  // (handled by the sibling refresh/route.ts) if it expires or is reused.
  let accountLink
  const refreshUrl = new URL('/agent/stripe-onboard', baseUrl)
  refreshUrl.searchParams.set('refresh', '1')
  refreshUrl.searchParams.set('agent_db_id', params.id)
  const returnUrl = new URL('/agent/stripe-onboard', baseUrl)
  returnUrl.searchParams.set('success', '1')
  returnUrl.searchParams.set('agent_db_id', params.id)
  if (resolved.taskId) {
    refreshUrl.searchParams.set('task_id', resolved.taskId)
    returnUrl.searchParams.set('task_id', resolved.taskId)
  }
  try {
    accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl.toString(),
      return_url: returnUrl.toString(),
      type: 'account_onboarding',
    })
  } catch (linkErr) {
    // Never the raw Stripe exception to the caller, and never the link
    // itself (there isn't one — creation failed) in the log.
    console.error('Failed to create Stripe account link:', linkErr instanceof Error ? linkErr.message : linkErr)
    return NextResponse.json({ error: 'Could not create a Stripe onboarding link right now. Please try again shortly.' }, { status: 502 })
  }

  await auditLog({
    action: 'stripe_connect_onboard_initiated',
    resource_type: 'agent',
    resource_id: params.id,
    details: { stripe_account_id: stripeAccountId, account_requirement: accountRequirement, task_id: resolved.taskId },
  })

  return NextResponse.json({
    onboarding_url: accountLink.url,
    stripe_account_id: stripeAccountId,
    country,
    supported_payment_methods: countryConfig.supportsSepaDebit ? ['card', 'sepa_debit'] : ['card'],
    expires_at: new Date(accountLink.expires_at * 1000).toISOString(),
    task_id: resolved.taskId,
    ...responsibility,
  })
}

// GET /api/v1/agents/:id/stripe-onboard
// Checks current Stripe Connect onboarding status and marks complete if done.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.tier !== 'admin' && token.agent_id !== params.id) {
    return NextResponse.json({ error: 'Forbidden — only the agent itself or an admin can view its Stripe onboarding status' }, { status: 403 })
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const db = getSupabase()

  const taskId = request.nextUrl.searchParams.get('task_id')

  const { data: agent } = await db
    .from('agents')
    .select('id, stripe_account_id, stripe_onboarding_completed, stripe_standard_account_id, stripe_standard_onboarding_completed')
    .eq('id', params.id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  const resolved = await resolveOnboardingRequirement(db, taskId, agent.id)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const accountRequirement = resolved.requirement
  const accountFields = stripeAccountFields(accountRequirement)
  const responsibility = publicPaymentResponsibility(accountRequirement)
  const stripeAccountId = agent[accountFields.accountId]
  const storedOnboardingCompleted = agent[accountFields.onboardingCompleted]
  if (!stripeAccountId) {
    return NextResponse.json({
      onboarding_completed: false,
      stripe_account_id: null,
      task_id: resolved.taskId,
      ...responsibility,
    })
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  const account = await stripe.accounts.retrieve(stripeAccountId)
  if (!stripeAccountMatchesRequirement(account, accountRequirement)) {
    return NextResponse.json({
      error: `The stored Stripe account does not match the required ${accountFields.stripeType} responsibility model.`,
      stripe_account_id: stripeAccountId,
      ...responsibility,
    }, { status: 409 })
  }

  const readiness = computeStripeAccountReadiness(account)
  const completed = readiness.onboardingComplete

  // Recomputed from live Stripe data on every call, in both directions — a
  // capability Stripe later restricts (e.g. after its own compliance
  // review) must be able to flip this back to false. The old check
  // (details_submitted && no currently_due items) only ever moved this flag
  // from false to true and never looked at capabilities, payouts_enabled,
  // or a later restriction at all.
  await syncOnboardingCompletedFlag(db, agent.id, storedOnboardingCompleted, completed, accountFields.onboardingCompleted)

  const accountCountry = typeof account.country === 'string' ? account.country.toUpperCase() : null

  return NextResponse.json({
    onboarding_completed: completed,
    stripe_account_id: stripeAccountId,
    payout_ready: readiness.payoutReady,
    card_ready: readiness.cardReady,
    sepa_debit_ready: readiness.sepaDebitReady,
    card_payments_status: readiness.cardPaymentsStatus,
    sepa_debit_payments_status: readiness.sepaDebitPaymentsStatus,
    transfers_status: readiness.transfersStatus,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    requirements: account.requirements?.currently_due ?? [],
    country: accountCountry,
    // Whether this specific account's country currently permits a NEW
    // Direct Charge payment (see isPaymentCountryEnabled — the same
    // intersection gate POST /api/v1/payments/create-intent enforces).
    // A verified, fully-ready account can still be payment_enabled=false
    // if Mercatai hasn't turned on live payments for its country yet —
    // the UI must not claim otherwise once onboarding completes.
    payment_enabled: accountCountry ? isPaymentCountryEnabled(accountCountry, accountFields.stripeType) : false,
    task_id: resolved.taskId,
    ...responsibility,
  })
}
