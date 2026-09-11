import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getSupabase } from '@/lib/server/supabase'
import {
  claimConnectEvent,
  markConnectEventCompleted,
  markConnectEventFailed,
  handleAccountUpdated,
  handlePayoutEvent,
} from '@/lib/server/stripeConnectMonitoring'

const PAYOUT_EVENT_TYPES = new Set(['payout.created', 'payout.updated', 'payout.paid', 'payout.failed'])

/**
 * Stripe Connect webhook — events "on connected accounts"
 * (account.updated, payout.*), deliberately separate from the
 * payment-lifecycle webhook at /api/v1/payments/stripe-webhook and its own
 * STRIPE_CONNECT_WEBHOOK_SECRET: a production Stripe event destination
 * configured to receive connected-account events can have its own signing
 * secret, independent of the platform-account payment webhook's.
 *
 * This route only ever watches connected accounts and payouts — it never
 * writes to tasks or transactions. See stripeConnectMonitoring.ts for why
 * a payout can't be attached to a single task/transaction.
 */
export async function POST(request: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Stripe Connect webhook is not configured' }, { status: 503 })
  }

  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') ?? ''
  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_CONNECT_WEBHOOK_SECRET)
  } catch {
    return NextResponse.json({ error: 'Webhook signature invalid' }, { status: 400 })
  }

  const db = getSupabase()

  let claim
  try {
    claim = await claimConnectEvent(db, event)
  } catch {
    // Never the raw Stripe/Postgres error, and never the event body.
    console.error(`stripe-connect-webhook: failed to claim event ${event.id} (${event.type})`)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  if (!claim.claimed) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    if (event.type === 'account.updated') {
      await handleAccountUpdated(db, event)
    } else if (PAYOUT_EVENT_TYPES.has(event.type)) {
      await handlePayoutEvent(db, event)
    }
    // Only marked completed once every critical write above has actually
    // succeeded — a thrown error below skips this and marks 'failed'
    // instead, so a genuine Stripe retry (a fresh delivery of this same
    // event) gets to finish the work.
    await markConnectEventCompleted(db, claim.id)
  } catch {
    console.error(`stripe-connect-webhook: processing failed for event ${event.id} (${event.type})`)
    await markConnectEventFailed(db, claim.id)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
