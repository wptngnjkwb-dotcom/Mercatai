import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getSupabase } from '@/lib/server/supabase'
import { reconcilePaymentIntent } from '@/lib/server/paymentState'
import { handleDisputeEvent } from '@/lib/server/paymentDisputes'

const DISPUTE_EVENT_TYPES = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'])

/**
 * Payment lifecycle webhook (separate from the developer subscription
 * webhook and from the Connect webhook at
 * /api/v1/payments/stripe-connect-webhook). Register, on a "Your
 * account" event destination:
 *   payment_intent.amount_capturable_updated, payment_intent.processing,
 *   payment_intent.succeeded, payment_intent.payment_failed,
 *   payment_intent.canceled, charge.dispute.created,
 *   charge.dispute.updated, charge.dispute.closed.
 * See docs/stripe-payment-webhook-runbook.md for the exact Stripe
 * Dashboard + Vercel setup and how to verify it once configured.
 *
 * Dispute events belong HERE, not the Connect webhook: Mercatai's
 * current destination-charge architecture (transfer_data.destination +
 * on_behalf_of) creates the Charge object on the PLATFORM's own Stripe
 * account — on_behalf_of only changes settlement-merchant attribution
 * for statement-descriptor purposes, it does not move the Charge object
 * to the connected account. Disputes on that Charge therefore fire on
 * the platform's own event stream. If the charge model ever changes to
 * Direct charges, this would need to move to the Connect webhook instead
 * — see docs/stripe-connect-country-support.md.
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
      // Webhook deliveries may arrive out of order. Always reconcile the
      // current Stripe object, not the historical snapshot embedded in the
      // event, so an old failure cannot roll back a later successful
      // payment. This also means a synthetic test event from the Stripe
      // Dashboard's "Send test webhook" feature (a canned payload
      // referencing a PaymentIntent id that was never actually created)
      // legitimately fails here with a real Stripe "no such payment_intent"
      // error — that is not a bug, and must not be treated as one; see
      // docs/stripe-payment-webhook-runbook.md's verification section for
      // what a genuine positive test looks like instead.
      const eventIntent = event.data.object as Stripe.PaymentIntent
      const currentIntent = await stripe.paymentIntents.retrieve(eventIntent.id)
      await reconcilePaymentIntent(currentIntent, event.type, stripe)
    } catch (err) {
      // A partial DB transition must be retried by Stripe. Keep the response
      // generic so no database or Stripe details leak to the caller.
      console.error('Payment reconciliation failed', err)
      return NextResponse.json({ error: 'Payment reconciliation failed' }, { status: 500 })
    }
  } else if (DISPUTE_EVENT_TYPES.has(event.type)) {
    try {
      // Dynamic import (like `stripe` above), not a static top-level one —
      // keeps this route file itself free of a compile-time dependency on
      // @/lib/server/email, which tests/stripe-connect-webhook.test.ts
      // mocks differently; see paymentDisputes.ts's DisputeAlertDeps doc
      // comment for the full isolate:false reasoning this avoids.
      const { buildDisputeAdminAlertProviderPayload, sendDisputeAdminAlertOrThrow } = await import('@/lib/server/email')
      await handleDisputeEvent(getSupabase(), stripe, event, {
        buildPayload: buildDisputeAdminAlertProviderPayload,
        sendAlert: sendDisputeAdminAlertOrThrow,
      })
    } catch (err) {
      // Same contract as the payment_intent branch: retry-on-500, never a
      // raw error in the response. Monitoring-only — see
      // paymentDisputes.ts — so a failure here never risks a duplicate
      // refund or transfer; it only risks a delayed admin alert, which
      // Stripe's automatic retry resolves.
      console.error('Dispute handling failed', err)
      return NextResponse.json({ error: 'Dispute handling failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ received: true })
}
