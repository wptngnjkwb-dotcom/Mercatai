import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { getOnboardingCountry } from '@/lib/onboardingCountries'

// POST /api/v1/agents/:id/stripe-onboard/refresh
//
// Stripe account_onboarding links are short-lived and single-use — Stripe
// sends the agent back to `refresh_url` (not `return_url`) whenever the one
// they were on has expired or already been consumed, without completing
// onboarding. The page that URL points at used to just read `?refresh=1`
// and do nothing with it, leaving the agent stuck with no way forward
// short of restarting onboarding from scratch (which the main POST handler
// on the parent route also refuses to do a second time for the same
// agent+country — see its "does not create a second account" 409).
//
// This endpoint exists to do exactly one thing safely: mint a fresh
// account_onboarding link for the agent's EXISTING Stripe account, never a
// new account. The country comes from the Stripe account itself
// (account.country) — never from a request parameter — since by the time a
// refresh is needed the account (and its country) already exist; asking
// the client to resubmit it would be redundant and, unlike at creation
// time, has nothing to validate against.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.tier !== 'admin' && token.agent_id !== params.id) {
    return NextResponse.json({ error: 'Forbidden — only the agent itself or an admin can refresh its Stripe onboarding link' }, { status: 403 })
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const db = getSupabase()
  const { data: agent } = await db
    .from('agents')
    .select('id, stripe_account_id')
    .eq('id', params.id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  if (!agent.stripe_account_id) {
    return NextResponse.json({
      error: 'This agent has not started Stripe onboarding yet — there is no existing account to refresh a link for.',
    }, { status: 400 })
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let account
  try {
    account = await stripe.accounts.retrieve(agent.stripe_account_id)
  } catch (stripeErr) {
    const message = stripeErr instanceof Error ? stripeErr.message : 'Could not retrieve the existing Stripe account'
    return NextResponse.json({ error: message, stripe_account_id: agent.stripe_account_id }, { status: 502 })
  }

  if (account.requirements?.disabled_reason) {
    return NextResponse.json({
      error: `This Stripe account needs manual review (Stripe's reason: ${account.requirements.disabled_reason}). Check the Stripe Dashboard or contact Stripe support directly — a new onboarding link cannot resolve this.`,
      stripe_account_id: agent.stripe_account_id,
      action_required: 'manual_stripe_dashboard_review',
      disabled_reason: account.requirements.disabled_reason,
    }, { status: 409 })
  }

  const country = typeof account.country === 'string' ? account.country.toUpperCase() : undefined
  const countryConfig = country ? getOnboardingCountry(country) : undefined

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mercatai.eu'

  // Same account every time — this call can never create a new one. Stripe
  // account_onboarding links are Stripe-hosted end to end; nothing here
  // collects identity, bank, or ToS data directly.
  const accountLink = await stripe.accountLinks.create({
    account: agent.stripe_account_id,
    refresh_url: `${baseUrl}/agent/stripe-onboard?refresh=1&agent_db_id=${params.id}`,
    return_url: `${baseUrl}/agent/stripe-onboard?success=1&agent_db_id=${params.id}`,
    type: 'account_onboarding',
  })

  // The link itself is never logged, emailed, or persisted — only the
  // account id, same restraint as the parent route's own audit entries.
  await auditLog({
    action: 'stripe_connect_onboard_link_refreshed',
    resource_type: 'agent',
    resource_id: params.id,
    details: { stripe_account_id: agent.stripe_account_id },
  })

  return NextResponse.json({
    onboarding_url: accountLink.url,
    stripe_account_id: agent.stripe_account_id,
    country,
    ...(countryConfig ? { supported_payment_methods: countryConfig.supportsSepaDebit ? ['card', 'sepa_debit'] : ['card'] } : {}),
    expires_at: new Date(accountLink.expires_at * 1000).toISOString(),
  })
}
