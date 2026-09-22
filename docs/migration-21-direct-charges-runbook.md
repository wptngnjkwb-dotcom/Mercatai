# Production runbook — migration 21 and Direct Charges

Migration 21 changes production payment behavior. Apply it only to the
Mercatai production project, after a verified backup, and before deploying
the matching application code.

## 1. Pre-flight

- Confirm the selected Supabase project is Mercatai.
- Confirm current application HEAD and the intended Direct Charge commit.
- Take a database backup or verified logical snapshot.
- Confirm the platform-account and connected-account webhook secrets are
  separately configured.

## 2. Apply

Run the complete contents of:

`frontend/sql/21_direct_charges.sql`

The migration is additive and idempotent. It:

- adds immutable charge-model/account context to transactions;
- tags existing PaymentIntent rows as `destination`;
- adds connected-account context to disputes;
- creates the context-binding and v2 payment-identity RPCs; and
- restricts both RPCs to `service_role`.

## 3. Verify in SQL

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'transactions'
  AND column_name IN ('stripe_charge_model', 'stripe_connected_account_id')
ORDER BY column_name;

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'payment_disputes'
  AND column_name = 'stripe_connected_account_id';

SELECT p.proname, p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'bind_payment_charge_context',
    'record_payment_charge_identity_v2'
  )
ORDER BY p.proname;

SELECT stripe_charge_model, COUNT(*)
FROM transactions
GROUP BY stripe_charge_model
ORDER BY stripe_charge_model NULLS FIRST;
```

Expected:

- all three new columns exist;
- both functions exist;
- ACL grants execution only to `service_role` (not PUBLIC, anon or
  authenticated);
- every existing row with a PaymentIntent is tagged `destination`.

## 4. Stripe/Vercel configuration

1. Connected-account event destination:
   `https://www.mercatai.eu/api/v1/payments/stripe-connect-webhook`.
2. Add the Direct Charge `payment_intent.*` and `charge.dispute.*`
   events listed in `docs/eu-payments-rollout.md`.
3. Preserve the legacy platform webhook for old destination-charge rows.
4. Set `STRIPE_CONNECT_ENABLED_COUNTRIES` to the reviewed EU/EEA + UK
   list.
5. Redeploy after environment changes.

Never copy signing or API secrets into SQL, terminal arguments, logs, issues
or this runbook.

## 5. Post-deploy smoke checks

- Country endpoint, OpenAPI and discovery JSON expose the same country set.
- Stripe onboarding page loads and GB is listed as card + SEPA.
- Invalid signatures return 400 (not 503) on both webhook endpoints.
- Existing non-payment pages return no 5xx.
- Do not create a live charge during a read-only smoke test.

## 6. Test-mode financial verification

Use an isolated test task and test connected account:

- Direct card PaymentIntent is visible in the connected account, not the
  platform namespace.
- Payment Element uses the returned connected-account context.
- Card authorize/capture/refund completes and Mercatai receives the
  application fee.
- SEPA success/failure/refund is reconciled through the connected-account
  webhook.
- Re-delivery is idempotent.
- A mismatched connected-account event returns 500 and mutates nothing.
- Legacy destination-charge fixtures still use the platform namespace.

Only a later small live pilot can verify an actual bank payout.

## Rollback

Do not drop the new columns or functions while any Direct Charge transaction
exists. Application rollback is safe only if no Direct Charge was created,
or if the prior version is first taught to route existing Direct Charge rows
by their frozen connected-account context. Otherwise stop new payments and
repair forward.
