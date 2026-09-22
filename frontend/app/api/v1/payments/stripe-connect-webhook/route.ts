import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getSupabase } from '@/lib/server/supabase'
import {
  claimConnectEvent,
  markConnectEventCompleted,
  markConnectEventFailed,
  handleAccountUpdated,
  handlePayoutEvent,
  handleExternalAccountUpdated,
} from '@/lib/server/stripeConnectMonitoring'

const PAYOUT_EVENT_TYPES = new Set(['payout.created', 'payout.updated', 'payout.paid', 'payout.failed'])
const DISPUTE_EVENT_TYPES = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'])

/**
 * Stripe Connect webhook — events "on connected accounts"
 * (account.updated, account.external_account.updated, payout.* and the
 * payment/dispute events produced by Direct Charges),
 * deliberately separate from the payment-lifecycle webhook at
 * /api/v1/payments/stripe-webhook and its own
 * STRIPE_CONNECT_WEBHOOK_SECRET: a production Stripe event destination
 * configured to receive connected-account events can have its own
 * signing secret, independent of the platform-account payment webhook's.
 *
 * Account/payout handlers never move task money. Direct-charge
 * payment_intent handlers do reconcile transactions/tasks, while dispute
 * handlers only record/alert and never move money. See
 * stripeConnectMonitoring.ts for why a payout can't be attached to a
 * single task/transaction. Every financial handler re-fetches current
 * state from Stripe rather than trusting the event's embedded snapshot
 * (Stripe does not guarantee delivery order).
 *
 * A 200 is returned ONLY once the claimed event's row is confirmed
 * 'completed' in the database — markConnectEventCompleted throws on any
 * database error or on affecting zero rows (its lease was reclaimed by a
 * newer attempt), and that throw is caught below and turned into a 500
 * like any other processing failure, never silently treated as success.
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
      await handleAccountUpdated(db, stripe, event)
    } else if (PAYOUT_EVENT_TYPES.has(event.type)) {
      await handlePayoutEvent(db, stripe, event)
    } else if (event.type === 'account.external_account.updated') {
      await handleExternalAccountUpdated(db, event)
    } else if (event.type.startsWith('payment_intent.')) {
      if (!event.account) throw new Error('Direct-charge payment event has no connected account')
      const { reconcilePaymentIntent } = await import('@/lib/server/paymentState')
      const eventIntent = event.data.object as Stripe.PaymentIntent
      const currentIntent = await stripe.paymentIntents.retrieve(eventIntent.id, { stripeAccount: event.account })
      await reconcilePaymentIntent(currentIntent, event.type, stripe, {
        chargeModel: 'direct',
        connectedAccountId: event.account,
      })
    } else if (DISPUTE_EVENT_TYPES.has(event.type)) {
      if (!event.account) throw new Error('Direct-charge dispute event has no connected account')
      const { handleDisputeEvent } = await import('@/lib/server/paymentDisputes')
      const { buildDisputeAdminAlertProviderPayload, sendDisputeAdminAlertOrThrow } = await import('@/lib/server/email')
      await handleDisputeEvent(db, stripe, event, {
        buildPayload: buildDisputeAdminAlertProviderPayload,
        sendAlert: sendDisputeAdminAlertOrThrow,
      }, event.account)
    }
    // Only reached — and only returns success — once every critical write
    // above has actually succeeded AND this specific completion write is
    // itself confirmed. A thrown error anywhere above skips this entirely.
    await markConnectEventCompleted(db, claim.id, claim.claimToken)
  } catch (processingErr) {
    const message = processingErr instanceof Error ? processingErr.message : 'unknown error'
    console.error(`stripe-connect-webhook: processing failed for event ${event.id} (${event.type}): ${message}`)
    try {
      await markConnectEventFailed(db, claim.id, claim.claimToken, message)
    } catch (markErr) {
      // Still safe: the stale-lease branch of claim_stripe_connect_event
      // lets a future delivery reclaim this row once its lease expires,
      // even though this particular attempt could not persist 'failed'.
      console.error(`stripe-connect-webhook: additionally failed to mark event ${event.id} failed:`, markErr instanceof Error ? markErr.message : markErr)
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
