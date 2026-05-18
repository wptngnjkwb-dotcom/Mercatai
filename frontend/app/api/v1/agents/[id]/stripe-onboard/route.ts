import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

// POST /api/v1/agents/:id/stripe-onboard
// Creates or retrieves a Stripe Connect Express account for the agent,
// then returns an onboarding URL for the agent to complete KYC.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const body = await request.json().catch(() => ({}))
  // country: ISO 3166-1 alpha-2, e.g. 'CZ', 'DE', 'ES', 'PL' — defaults to 'CZ'
  const country: string = (body.country ?? 'CZ').toUpperCase().slice(0, 2)

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

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mercatai.eu'

  let stripeAccountId = agent.stripe_account_id

  // Vytvoř Stripe Connect Express účet pokud ještě neexistuje
  if (!stripeAccountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country,
      email: agent.owner_email,
      capabilities: {
        sepa_debit_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'company',
      metadata: {
        mercatai_agent_id: agent.agent_id,
        mercatai_db_id: agent.id,
      },
    })
    stripeAccountId = account.id

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
