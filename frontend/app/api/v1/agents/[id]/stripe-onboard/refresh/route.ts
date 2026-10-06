import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { getOnboardingCountry, requiredCapabilitiesForCountry } from '@/lib/onboardingCountries'
import {
  computeStripeAccountReadiness,
  classifyDisabledReason,
  disabledReasonBlockingResponse,
} from '@/lib/server/stripeAccountReadiness'
import {
  publicPaymentResponsibility,
  resolveOnboardingRequirement,
  stripeAccountFields,
  stripeAccountMatchesRequirement,
} from '@/lib/server/stripeAccountRequirement'

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

  const body = await request.json().catch(() => ({}))
  const bodyTaskId = typeof body.task_id === 'string' && body.task_id.trim() ? body.task_id.trim() : null
  const taskId = bodyTaskId ?? request.nextUrl.searchParams.get('task_id')
  const db = getSupabase()
  const { data: agent } = await db
    .from('agents')
    .select('id, stripe_account_id, stripe_standard_account_id')
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
  if (!stripeAccountId) {
    return NextResponse.json({
      error: 'This agent has not started Stripe onboarding yet — there is no existing account to refresh a link for.',
      ...responsibility,
    }, { status: 400 })
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let account
  try {
    account = await stripe.accounts.retrieve(stripeAccountId)
  } catch (stripeErr) {
    const message = stripeErr instanceof Error ? stripeErr.message : 'Could not retrieve the existing Stripe account'
    return NextResponse.json({ error: message, stripe_account_id: stripeAccountId }, { status: 502 })
  }
  if (!stripeAccountMatchesRequirement(account, accountRequirement)) {
    return NextResponse.json({
      error: `The stored Stripe account does not match the required ${accountFields.stripeType} responsibility model.`,
      stripe_account_id: stripeAccountId,
      ...responsibility,
    }, { status: 409 })
  }

  // Some disabled_reason values (requirements.past_due,
  // action_required.requested_capabilities) are normal, self-service states
  // a fresh onboarding link resolves — only genuinely blocked or
  // Stripe-side-pending states short-circuit here. Same classification the
  // parent route uses — see frontend/lib/server/stripeAccountReadiness.ts.
  const disabledClassification = classifyDisabledReason(account.requirements?.disabled_reason)
  const blocking = disabledReasonBlockingResponse(disabledClassification, stripeAccountId)
  if (blocking) {
    return NextResponse.json(blocking.body, { status: blocking.status })
  }

  const country = typeof account.country === 'string' ? account.country.toUpperCase() : undefined
  const countryConfig = country ? getOnboardingCountry(country) : undefined

  // A capability can go missing without disabled_reason ever mentioning it
  // by name (e.g. a legacy account from before a capability was added to
  // what Mercatai requests for its country) — so this isn't gated strictly
  // on disabledClassification being request_capabilities_then_proceed; it
  // mirrors the parent route's own unconditional check, just without that
  // route's separate "already completed" short-circuit (a refresh is
  // always trying to move an incomplete account forward).
  const requiredCapabilities = countryConfig ? requiredCapabilitiesForCountry(countryConfig.code, accountFields.stripeType) : null
  if (requiredCapabilities) {
    const readiness = computeStripeAccountReadiness(account)
    const missingCapabilities: Record<string, { requested: true }> = {}
    if (requiredCapabilities.card_payments && readiness.cardPaymentsStatus !== 'active') {
      missingCapabilities.card_payments = { requested: true }
    }
    if (requiredCapabilities.sepa_debit_payments && readiness.sepaDebitPaymentsStatus !== 'active') {
      missingCapabilities.sepa_debit_payments = { requested: true }
    }
    // Stripe pairs `transfers` with `card_payments` at the request level —
    // see RequiredStripeCapabilities in onboardingCountries.ts.
    if (requiredCapabilities.transfers && readiness.transfersStatus !== 'active') {
      missingCapabilities.transfers = { requested: true }
    }
    if (Object.keys(missingCapabilities).length > 0) {
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
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mercatai.eu'
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

  // Same account every time — this call can never create a new one. Stripe
  // account_onboarding links are Stripe-hosted end to end; nothing here
  // collects identity, bank, or ToS data directly.
  let accountLink
  try {
    accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl.toString(),
      return_url: returnUrl.toString(),
      type: 'account_onboarding',
    })
  } catch (linkErr) {
    console.error('Failed to create Stripe account link:', linkErr instanceof Error ? linkErr.message : linkErr)
    return NextResponse.json({ error: 'Could not create a Stripe onboarding link right now. Please try again shortly.' }, { status: 502 })
  }

  // The link itself is never logged, emailed, or persisted — only the
  // account id, same restraint as the parent route's own audit entries.
  await auditLog({
    action: 'stripe_connect_onboard_link_refreshed',
    resource_type: 'agent',
    resource_id: params.id,
    details: { stripe_account_id: stripeAccountId, account_requirement: accountRequirement, task_id: resolved.taskId },
  })

  return NextResponse.json({
    onboarding_url: accountLink.url,
    stripe_account_id: stripeAccountId,
    country,
    ...(countryConfig ? { supported_payment_methods: countryConfig.supportsSepaDebit ? ['card', 'sepa_debit'] : ['card'] } : {}),
    expires_at: new Date(accountLink.expires_at * 1000).toISOString(),
    task_id: resolved.taskId,
    ...responsibility,
  })
}
