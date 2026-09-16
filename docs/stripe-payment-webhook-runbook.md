# Main payment webhook — activation runbook

Operational guide for `POST /api/v1/payments/stripe-webhook` (the
platform-account payment-lifecycle webhook — deliberately separate from
the Connect webhook at `/api/v1/payments/stripe-connect-webhook`, which
watches connected accounts and payouts and has its own signing secret,
`STRIPE_CONNECT_WEBHOOK_SECRET`).

## Why it currently answers 503

`POST /api/v1/payments/stripe-webhook` returns `503 {"error":"Stripe
webhook is not configured"}` whenever either `STRIPE_SECRET_KEY` or
`STRIPE_WEBHOOK_SECRET` is unset (see
`frontend/app/api/v1/payments/stripe-webhook/route.ts`). `STRIPE_SECRET_KEY`
is shared with other Stripe-dependent endpoints and is already set — the
missing piece is `STRIPE_WEBHOOK_SECRET`, which belongs to a Stripe event
destination that has never been created for this specific webhook.

## What this endpoint actually handles

Verified directly against the route's own source, never invented:

- `payment_intent.amount_capturable_updated`
- `payment_intent.processing`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`

Every other event type is accepted with `200 {"received": true}` and
otherwise ignored — Stripe does not need to retry these, but the route
never claims to have acted on them either.

## Activation steps

1. **Live mode** — a production event destination is created in Stripe's
   live mode, separately from test mode. **Test mode and live mode have
   entirely separate signing secrets** — a `whsec_...` copied from a test-mode
   destination will never validate a live webhook, and vice versa. Keep
   this straight: if you also want to exercise this endpoint in Stripe
   CLI / test mode locally, that requires its own, second
   `STRIPE_WEBHOOK_SECRET` value, never the live one.
2. Stripe Dashboard → **Settings → Developers → Webhooks** (or Workbench →
   Event destinations) → **Add destination**.
3. **Event destination scope: "Your account"** — not "Connected accounts"
   (that scope is what the existing, already-working Connect webhook
   uses; this is the platform's own payment-lifecycle webhook).
4. Select exactly the eight event types listed above.
5. Destination type: **Webhook endpoint**.
6. Endpoint URL: `https://www.mercatai.eu/api/v1/payments/stripe-webhook`
7. Create the destination. Stripe shows a **signing secret**
   (`whsec_...`) — copy it, but **never paste it into a terminal command,
   a log line, a commit, or anywhere it could be echoed back to me or
   captured in shell history.**
8. Vercel → Project → Settings → Environment Variables (Production) →
   set `STRIPE_WEBHOOK_SECRET` to that value. While there, also confirm
   `STRIPE_SECRET_KEY` is set for the same (live) mode — a live
   `STRIPE_WEBHOOK_SECRET` paired with a stale test-mode
   `STRIPE_SECRET_KEY` (or vice versa) fails signature verification in a
   way that looks identical to a wrong secret.
9. Redeploy so the new environment variable takes effect.

## Verifying it — safely, without ever exposing the secret

All of the following are read-only or use Stripe's own test-mode tooling;
none of them require printing `STRIPE_WEBHOOK_SECRET` or `STRIPE_SECRET_KEY`
anywhere.

1. **Missing/invalid signature → 400, not 503.** A POST to the live URL
   with no `stripe-signature` header (or a garbage one) must now return
   `400 {"error":"Webhook signature invalid"}` instead of `503`. This
   alone confirms both env vars are set and the route is reading them.
2. **A genuine positive test requires a REAL test-mode PaymentIntent —
   not just "any accepted event".** This is a correction from an earlier
   draft of this runbook: Stripe Dashboard's own "Send test webhook"
   feature sends a **synthetic, canned payload** whose `PaymentIntent` id
   was never actually created in Stripe. Because this route always
   re-fetches the current object from Stripe before acting on it (see
   "Idempotent reconciliation" below), that synthetic id causes a real
   `paymentIntents.retrieve` failure — and the route correctly returns
   **500**, not 200. That 500 is expected and correct, not a bug (see
   `frontend/tests/stripe-webhook.test.ts`'s
   `positive acceptance criteria` describe block, which asserts exactly
   this). **A genuine positive test instead requires driving a real
   test-mode payment through Mercatai's own flow** (create a test task,
   accept a bid, call `POST /api/v1/payments/create-intent` with a Stripe
   test card), so the webhook fires for a `PaymentIntent` this
   deployment's own `transactions` table actually knows about — that
   delivery should return `200`.
3. **Idempotent redelivery.** Use the Stripe Dashboard's "Resend" on a
   delivered event (or trigger a duplicate via the Stripe CLI in test
   mode) — the second delivery of the same `payment_intent.succeeded`
   event must produce the same end state as the first, not a second
   `held` transition or a duplicate audit entry.
4. **Correct transaction state transitions.** `payment_intent.succeeded`
   moves a `pending` transaction to `held` and starts the task
   (`in_progress`); `payment_intent.payment_failed` moves it to `failed`.
5. **No secret or raw Stripe/DB error ever reaches a response or a log
   line.** Confirmed by `frontend/tests/stripe-webhook.test.ts`'s own
   assertions (`never leaks a raw Stripe error, a secret, or the API key
   in the response body`) — nothing further to check manually here.
6. **Dispute monitoring is observation-only.** Triggering a test dispute
   (Stripe test mode has a documented way to do this) should result in a
   `payment_disputes` row and — if `ADMIN_ALERT_EMAIL`/`RESEND_API_KEY`
   are configured — one admin alert email. It must never trigger a
   refund, a transfer reversal, or any other money movement; see
   `frontend/lib/server/paymentDisputes.ts`'s own module doc comment.

## What is NOT required to fix this

- No code change. No migration. No charge-model change. This is purely a
  Stripe Dashboard + Vercel environment-variable activation.
