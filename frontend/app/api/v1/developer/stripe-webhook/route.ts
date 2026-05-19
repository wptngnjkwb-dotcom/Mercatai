import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

/**
 * POST /api/v1/developer/stripe-webhook
 * Stripe sends events here when subscriptions change.
 * Activates / cancels the plan on the api_clients record.
 *
 * Register in Stripe Dashboard:
 *   Endpoint URL: https://mercatai.eu/api/v1/developer/stripe-webhook
 *   Events: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated
 */
export async function POST(request: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_DEVELOPER_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const body = await request.text()
  const sig = request.headers.get('stripe-signature') ?? ''

  let event: { type: string; data: { object: Record<string, unknown> } }
  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_DEVELOPER_WEBHOOK_SECRET) as unknown as typeof event
  } catch (err) {
    return NextResponse.json({ error: 'Webhook signature invalid' }, { status: 400 })
  }

  const db = getSupabase()

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { metadata?: { client_id?: string; plan?: string }; subscription?: string }
    const clientId = session.metadata?.client_id
    const plan = session.metadata?.plan
    const subscriptionId = session.subscription

    if (clientId && plan) {
      await db.from('api_clients').update({
        plan,
        stripe_subscription_id: subscriptionId ?? null,
      }).eq('id', clientId)
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as { id: string; metadata?: { client_id?: string } }
    const clientId = sub.metadata?.client_id

    if (clientId) {
      await db.from('api_clients').update({
        plan: 'free',
        stripe_subscription_id: null,
      }).eq('id', clientId)
    } else {
      // Fallback: match by subscription ID
      await db.from('api_clients').update({ plan: 'free', stripe_subscription_id: null })
        .eq('stripe_subscription_id', sub.id)
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object as { id: string; status: string; metadata?: { client_id?: string; plan?: string } }
    const clientId = sub.metadata?.client_id
    const plan = sub.metadata?.plan

    if (clientId && plan && sub.status === 'active') {
      await db.from('api_clients').update({ plan }).eq('id', clientId)
    }
  }

  return NextResponse.json({ received: true })
}
