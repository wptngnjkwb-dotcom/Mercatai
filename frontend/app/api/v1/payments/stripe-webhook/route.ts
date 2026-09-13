import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { reconcilePaymentIntent } from '@/lib/server/paymentState'

/**
 * Payment lifecycle webhook (separate from the developer subscription
 * webhook). Register payment_intent.amount_capturable_updated,
 * payment_intent.processing, payment_intent.succeeded,
 * payment_intent.payment_failed and payment_intent.canceled.
 */
export async function POST(request: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Stripe webhook is not configured' }, { status: 503 })
  }

  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') ?? ''
  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)
  } catch {
    return NextResponse.json({ error: 'Webhook signature invalid' }, { status: 400 })
  }

  if (event.type.startsWith('payment_intent.')) {
    try {
      await reconcilePaymentIntent(event.data.object as Stripe.PaymentIntent, event.type)
    } catch (err) {
      // A partial DB transition must be retried by Stripe. Keep the response
      // generic so no database or Stripe details leak to the caller.
      console.error('Payment reconciliation failed', err)
      return NextResponse.json({ error: 'Payment reconciliation failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ received: true })
}
