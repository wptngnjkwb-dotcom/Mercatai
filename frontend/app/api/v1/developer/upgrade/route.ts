import { NextRequest, NextResponse } from 'next/server'
import { resolveApiClient } from '@/lib/server/affiliate'
import { PLAN_PRICES } from '@/lib/server/apiUsage'
import { getSupabase } from '@/lib/server/supabase'

/**
 * POST /api/v1/developer/upgrade
 * Creates a Stripe Checkout session for upgrading an API client plan.
 *
 * Body: { plan: 'starter' | 'pro', success_url, cancel_url }
 * Returns: { checkout_url }
 */
export async function POST(request: NextRequest) {
  const apiClient = await resolveApiClient(request.headers.get('authorization'))
  if (!apiClient) {
    return NextResponse.json({ error: 'Unauthorized — provide mct_ API key' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { plan, success_url, cancel_url } = body

  if (!plan || !['starter', 'pro'].includes(plan)) {
    return NextResponse.json({ error: "plan must be 'starter' or 'pro'" }, { status: 400 })
  }

  const priceConfig = PLAN_PRICES[plan]
  if (!priceConfig?.stripe_price_id) {
    return NextResponse.json(
      { error: `Stripe price not configured for plan '${plan}'. Set STRIPE_PRICE_${plan.toUpperCase()} env var.` },
      { status: 503 }
    )
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceConfig.stripe_price_id, quantity: 1 }],
      success_url: success_url ?? `${process.env.NEXT_PUBLIC_BASE_URL ?? 'https://mercatai.eu'}/developer?upgraded=1`,
      cancel_url: cancel_url ?? `${process.env.NEXT_PUBLIC_BASE_URL ?? 'https://mercatai.eu'}/developer`,
      metadata: {
        client_id: apiClient.id,
        plan,
      },
      subscription_data: {
        metadata: { client_id: apiClient.id, plan },
      },
    })

    return NextResponse.json({ checkout_url: session.url, session_id: session.id })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
