# Migration 20 — production activation runbook

Operational guide for applying `frontend/sql/20_payment_charge_transfer_identity.sql`
to the production Supabase database, and for the deploy that follows it.
This document is preparation only — nothing here has been run against
production. Applying the migration, pushing commits `7b0e9b4` and
`2e2d456`, and redeploying remain separate, explicit actions for the
account owner.

## What this migration does, and why

Adds one function, `record_payment_charge_identity` (idempotent,
conflict-safe `stripe_charge_id`/`stripe_transfer_id` recording — see the
migration file's own extensive header comment for the full rationale). No
table, column, or RLS policy changes, no data migration, no backfill, no
destructive statement of any kind. That makes it idempotent and
low-risk to *apply* — but `CREATE OR REPLACE FUNCTION` is not
"inherently safe" in the sense that matters here: this function changes
production payment behavior (what gets written to `transactions` at
capture time, and — see `2e2d456` — whether a `succeeded` capture is
accepted at all without its Transfer). A backup beforehand and an
explicit permissions check afterward stay required regardless of how
mechanically simple the SQL is.

This closes a real, empirically-confirmed gap: `stripe_transfer_id` was
structurally never being persisted for a completed transaction, because
every path that finalizes one (buyer approve, admin dispute resolution,
the hourly escrow-release cron) flips `escrow_status` straight to
`released` in the same request as the Stripe capture, permanently
excluding it from the old best-effort helper's `pending`/`held`-only
gate. Found via a real Stripe test-mode sandbox run, not a hypothetical.

## Pre-application checklist

1. **Back up the production database first.** Standard precaution before
   any schema change, even one as low-risk as this — do this through
   Supabase's own backup/point-in-time-recovery tooling, not a step this
   runbook can perform.
2. Confirm which commit is currently deployed to production (Vercel →
   Deployments), so the migration's timing relative to the code deploy is
   known and intentional, not accidental.
3. Confirm `STRIPE_SECRET_KEY` in Vercel (Production) is the **live** key
   — this migration itself doesn't touch Stripe, but the post-deploy
   verification below does, and mixing up test/live here would silently
   invalidate that verification.

## Applying the migration

Run the full contents of `frontend/sql/20_payment_charge_transfer_identity.sql`
against the production database — Supabase Dashboard → SQL Editor (or
`psql` against the production connection string, whichever this project's
existing migration practice uses). The file is self-contained: one
`CREATE OR REPLACE FUNCTION`, one `REVOKE`, one `GRANT`. No other object
depends on running first.

## Verification — three distinct phases, not to be conflated

### Phase 1 — Test mode (already done, in the local isolated stack)

Card capture, SEPA success, SEPA failure, redelivery idempotency, a
conflicting-id rejection, and the `succeeded`-requires-transfer /
`requires_capture`-charge-only distinction were all driven through a real
Stripe test-mode account against the local self-hosted stack (isolated
Docker Postgres, never the production database) earlier in this
engagement, plus the direct SQL verification of
`record_payment_charge_identity`'s write rules against a fresh local
Postgres instance. This is genuine coverage of the *logic* — it is not,
and must not be described as, coverage of the production deployment or
of real banking rails.

### Phase 2 — After production deploy (read-only, configuration only)

This phase confirms the migration and the code deployed correctly — it
proves nothing about whether money actually moves correctly, and must
not be described as if it did.

1. **Function exists:**
   ```sql
   SELECT proname FROM pg_proc WHERE proname = 'record_payment_charge_identity';
   ```
2. **Permissions are correctly restricted to `service_role` only** — this
   is the one part of this migration where production and the local
   self-hosted stack actually differ: a real Supabase project has always
   provisioned `anon`, `authenticated`, and `service_role`, so — unlike
   the local stack before commit `2e2d456`'s `00_roles.sql` fix — this
   `REVOKE ... FROM PUBLIC, anon, authenticated` has never had a missing-
   role problem here. Confirm it anyway:
   ```sql
   SELECT proacl FROM pg_proc WHERE proname = 'record_payment_charge_identity';
   ```
   Expected: only the owner and `service_role` hold `X` (execute) — no
   bare `=X` entry (that would mean `PUBLIC` still has access).
3. **Public endpoints are healthy, no 5xx.** Hit the ordinary read
   endpoints (`GET /api/v1/tasks`, `GET /api/v1/payments/config`, etc.)
   and confirm normal 2xx/4xx responses — the deploy didn't break
   anything unrelated.
4. **The payment webhook rejects an invalid signature correctly.** A POST
   to `/api/v1/payments/stripe-webhook` with no `stripe-signature` header
   (or a garbage one) must return `400`, not `503` — confirming
   `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are still set post-deploy,
   without needing a real payment to check it.

### Phase 3 — Production E2E (the first real, small, live paid pilot)

Nothing above is a substitute for this. The live capture → Transfer →
identity-recording path, with real card networks and Stripe's live-mode
timing, is only actually verified once a genuine live transaction —
Mercatai's first small paid pilot — completes and its row is inspected:

```sql
SELECT stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id, escrow_status
FROM transactions WHERE id = '<transaction_id>';
```

Expected: `escrow_status = 'released'` **and** both `stripe_charge_id`
and `stripe_transfer_id` populated — the second of which the
pre-migration code would have left `NULL` forever. **Until a live
transaction like this has actually happened and been checked, do not
describe the live/banking flow as verified** — Phase 1 verified the
logic in test mode, Phase 2 verifies the deployment is wired correctly;
only Phase 3 verifies real money actually behaves as designed.

## What this runbook deliberately does not do

- Does not apply the migration to production — that SQL execution is the
  account owner's own action, against a database this environment has no
  credentials for.
- Does not push `7b0e9b4` or `2e2d456`, or trigger a deploy.
- Does not initiate or simulate a live Stripe charge — Phase 3 describes
  inspecting the result of a genuine live pilot transaction the account
  owner runs through the product as a real buyer, not an action this
  runbook or this environment performs.
- Does not claim the live/banking flow is verified before Phase 3 has
  actually happened — see that section.
