import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

// Full ISO 3166-1 alpha-2 country code set. Used only to reject malformed
// input (e.g. 'XX', 'ZZ', a truncated string) before ever calling Stripe —
// it is not a claim that Stripe supports every one of these countries as a
// platform or connected-account country. Stripe's own accounts.create call
// remains the authority on that; an unsupported-but-well-formed code is
// rejected by Stripe itself and surfaced below as a clear 4xx.
const ISO_3166_1_ALPHA_2 = new Set(
  ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
    + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
    + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
    + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ '
    + 'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
    + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ '
    + 'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ')
)

// Stripe's legal-entity structures for a connected account. Left unset by
// default so Stripe's hosted onboarding asks the agent directly — see
// docs/stripe-norway-onboarding.md for why this must not be hardcoded to
// 'company'.
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

  // country: ISO 3166-1 alpha-2, e.g. 'CZ', 'NO' — defaults to 'CZ'. Must be
  // a real country code, not just any two characters, so a typo or garbage
  // value is rejected here rather than silently truncated and sent to
  // Stripe. Stripe itself remains the authority on whether this specific
  // country is actually supported for a platform or connected account.
  const rawCountry = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  const country = rawCountry || 'CZ'
  if (!ISO_3166_1_ALPHA_2.has(country)) {
    return NextResponse.json({ error: `'${rawCountry || body.country}' is not a valid ISO 3166-1 alpha-2 country code.` }, { status: 400 })
  }

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

  const completed = account.details_submitted && !account.requirements?.currently_due?.length

  if (completed && !agent.stripe_onboarding_completed) {
    await db.from('agents')
      .update({ stripe_onboarding_completed: true })
      .eq('id', params.id)

    await auditLog({
      action: 'stripe_connect_onboard_completed',
      resource_type: 'agent',
      resource_id: params.id,
      details: { stripe_account_id: agent.stripe_account_id },
    })
  }

  return NextResponse.json({
    onboarding_completed: completed,
    stripe_account_id: agent.stripe_account_id,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    requirements: account.requirements?.currently_due ?? [],
  })
}
