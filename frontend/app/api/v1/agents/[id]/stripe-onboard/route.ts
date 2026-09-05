import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { SUPPORTED_ONBOARDING_COUNTRIES, isSupportedOnboardingCountry } from '@/lib/onboardingCountries'
import { computeStripeAccountReadiness } from '@/lib/server/stripeAccountReadiness'

// Stripe's legal-entity structures for a connected account. Left unset by
// default so Stripe's hosted onboarding asks the account holder directly —
// see docs/stripe-norway-onboarding.md for why business_type must not be
// hardcoded, and must not be inferred from country either (e.g. 'individual'
// is *an available* legal form for a Norwegian account, not the one Mercatai
// should assume for every Norwegian agent).
const ALLOWED_BUSINESS_TYPES = new Set(['individual', 'company', 'non_profit', 'government_entity'])

// POST /api/v1/agents/:id/stripe-onboard
// Creates or retrieves a Stripe Connect Express account for the agent,
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

  // country: ISO 3166-1 alpha-2, e.g. 'CZ', 'NO'. Required — no default. A
  // connected account's country is difficult to change after creation, so
  // silently defaulting a foreign agent to 'CZ' risks creating a Stripe
  // account that agent can never actually use. The caller must supply the
  // country explicitly, and it must match the actual country of the person
  // or business that will hold this payout account.
  const rawCountry = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  if (!rawCountry) {
    return NextResponse.json({
      error: 'country is required (ISO 3166-1 alpha-2, e.g. "CZ" or "NO") — it must match the actual holder of the payout account.',
    }, { status: 400 })
  }
  if (!isSupportedOnboardingCountry(rawCountry)) {
    const supported = SUPPORTED_ONBOARDING_COUNTRIES.map((c) => c.code).join(', ')
    return NextResponse.json({ error: `'${rawCountry}' is not currently supported for onboarding. Supported countries: ${supported}.` }, { status: 400 })
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
    .select('id, agent_id, owner_email, stripe_account_id, stripe_onboarding_completed')
    .eq('id', params.id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  if (agent.stripe_onboarding_completed) {
    return NextResponse.json({ message: 'Stripe onboarding already completed', stripe_account_id: agent.stripe_account_id })
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

  let stripeAccountId = agent.stripe_account_id

  // Vytvoř Stripe Connect Express účet pokud ještě neexistuje
  if (!stripeAccountId) {
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        country,
        email: agent.owner_email,
        capabilities: {
          // card_payments must be requested alongside transfers for a
          // connected account to actually receive card-funded destination
          // charges made with on_behalf_of (as create-intent/route.ts does)
          // — requesting only sepa_debit_payments left card payouts
          // incompletely provisioned.
          card_payments: { requested: true },
          sepa_debit_payments: { requested: true },
          transfers: { requested: true },
        },
        ...(rawBusinessType ? { business_type: rawBusinessType as any } : {}),
        metadata: {
          mercatai_agent_id: agent.agent_id,
          mercatai_db_id: agent.id,
        },
      })
      stripeAccountId = account.id
    } catch (stripeErr) {
      console.error('Stripe account creation failed:', stripeErr)
      const message = stripeErr instanceof Error ? stripeErr.message : 'Stripe account creation failed'
      return NextResponse.json({ error: message }, { status: 502 })
    }

    await db.from('agents')
      .update({ stripe_account_id: stripeAccountId })
      .eq('id', params.id)
  }

  // Vygeneruj onboarding link (platí 24h)
  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${baseUrl}/agent/stripe-onboard?refresh=1&agent_db_id=${params.id}`,
    return_url: `${baseUrl}/agent/stripe-onboard?success=1&agent_db_id=${params.id}`,
    type: 'account_onboarding',
  })

  await auditLog({
    action: 'stripe_connect_onboard_initiated',
    resource_type: 'agent',
    resource_id: params.id,
    details: { stripe_account_id: stripeAccountId },
  })

  return NextResponse.json({
    onboarding_url: accountLink.url,
    stripe_account_id: stripeAccountId,
    expires_at: new Date(accountLink.expires_at * 1000).toISOString(),
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

  const { data: agent } = await db
    .from('agents')
    .select('id, stripe_account_id, stripe_onboarding_completed')
    .eq('id', params.id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  if (!agent.stripe_account_id) {
    return NextResponse.json({ onboarding_completed: false, stripe_account_id: null })
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  const account = await stripe.accounts.retrieve(agent.stripe_account_id)

  const readiness = computeStripeAccountReadiness(account)
  const completed = readiness.onboardingComplete

  // Recomputed from live Stripe data on every call, in both directions — a
  // capability Stripe later restricts (e.g. after its own compliance
  // review) must be able to flip this back to false. The old check
  // (details_submitted && no currently_due items) only ever moved this flag
  // from false to true and never looked at capabilities, payouts_enabled,
  // or a later restriction at all.
  if (completed !== agent.stripe_onboarding_completed) {
    await db.from('agents')
      .update({ stripe_onboarding_completed: completed })
      .eq('id', params.id)

    await auditLog({
      action: completed ? 'stripe_connect_onboard_completed' : 'stripe_connect_onboard_restricted',
      resource_type: 'agent',
      resource_id: params.id,
      details: { stripe_account_id: agent.stripe_account_id, ...readiness },
    })
  }

  return NextResponse.json({
    onboarding_completed: completed,
    stripe_account_id: agent.stripe_account_id,
    payout_ready: readiness.payoutReady,
    card_ready: readiness.cardReady,
    sepa_debit_ready: readiness.sepaDebitReady,
    card_payments_status: readiness.cardPaymentsStatus,
    sepa_debit_payments_status: readiness.sepaDebitPaymentsStatus,
    transfers_status: readiness.transfersStatus,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    requirements: account.requirements?.currently_due ?? [],
  })
}
