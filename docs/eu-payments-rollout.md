# EU/EEA + UK payments rollout — Direct Charges

Last reviewed: 2026-09-22.

## Decision

New Mercatai payments use Stripe Connect **Direct Charges**. The
PaymentIntent and Charge are created in the assigned agent's connected
account (`Stripe-Account: acct_...`); Mercatai receives only
`application_fee_amount`. Existing destination-charge payments keep their
original platform-account context and remain readable, capturable and
refundable.

This matches the commercial model: the agent/operator supplies the service
and is the Stripe merchant for the buyer payment. Mercatai provides the
marketplace and receives its application fee. It also avoids extending the
old cross-border `destination charge + on_behalf_of` shape to countries for
which Stripe does not support that flow.

Stripe may debit its own processing, FX, dispute, refund and payout fees from
the connected account, depending on the account's controller settings and
agreement. Mercatai's `agent_payout_eur` is therefore a historical API name:
it is the amount after Mercatai fees, not a guaranteed bank payout.

Primary Stripe references:

- https://docs.stripe.com/connect/direct-charges
- https://docs.stripe.com/payments/sepa-debit
- https://docs.stripe.com/connect/cross-border-payouts

## Public rollout set

Mercatai's default rollout is every catalog country in the EU/EEA for which
Stripe Express onboarding is supported, plus the UK:

```text
AT,BE,BG,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,IS,NO,GB
```

- Croatia and Liechtenstein remain excluded because they are not in the
  application's verified Stripe Express catalog. Re-check Stripe before
  adding either.
- Iceland is card-only in the current catalog.
- The UK supports card and SEPA Direct Debit. Stripe's SEPA documentation
  lists GB as a supported business location.
- Listing a country permits onboarding; it is not a promise that Stripe will
  approve a particular person, legal form, business or bank account.

## Hard deployment dependency

Migration 21 must be applied before the Direct Charge code is deployed. The
new code calls `bind_payment_charge_context` and
`record_payment_charge_identity_v2`; deploying first would make payment
creation and reconciliation fail.

Required order:

1. Back up the production database.
2. Apply `frontend/sql/21_direct_charges.sql`.
3. Verify new columns, both RPCs and service-role-only ACLs.
4. Update the Connect event destination to include Direct Charge payment and
   dispute events (see below).
5. Set the production country allowlist to the exact rollout set above.
6. Deploy the code.
7. Run read-only smoke checks, then isolated test-mode payments.

## Stripe event destinations

Keep both endpoints during the migration:

### Platform-account webhook — legacy payments

`/api/v1/payments/stripe-webhook` with `STRIPE_WEBHOOK_SECRET` continues to
process existing destination-charge PaymentIntents created in the platform
account.

### Connected-account webhook — all new payments

`/api/v1/payments/stripe-connect-webhook` with
`STRIPE_CONNECT_WEBHOOK_SECRET` must be configured for events **on connected
accounts** and include:

- `account.updated`
- `account.external_account.updated`
- `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`
- `payment_intent.amount_capturable_updated`
- `payment_intent.processing`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`

The event's `account` field is treated as security context. Mercatai
re-fetches the current Stripe object in that exact account namespace and
rejects a mismatch with the frozen transaction context.

## Capability and payment gates

Direct Charges request `card_payments`, plus `sepa_debit_payments` where the
country is in Stripe's SEPA business-location list. The old `transfers`
capability is not a Direct Charge prerequisite.

Before every buyer payment, Mercatai re-fetches the connected account and
requires:

- completed identity details and no currently-due requirements;
- `charges_enabled = true`;
- `payouts_enabled = true`; and
- the requested payment-method capability is `active`.

Those live checks are authoritative even when the public country allowlist
contains the country.

## Verification before announcing success

For FR, ES and GB first, then at least one country from each remaining group:

1. Complete hosted Express onboarding in Stripe test mode.
2. Confirm account country and payment/payout readiness from Stripe.
3. Card: authorize → task starts → deliver → approve → capture → refund.
4. SEPA where enabled: processing → succeeded webhook → task starts;
   separately exercise a failure IBAN and refund.
5. Confirm Direct Charge objects live in the connected account, Mercatai
   receives only the application fee, and all retries are idempotent.
6. Confirm connected-account webhook deliveries return 200 for genuine
   events and mismatched/synthetic events fail closed.

A test-mode payout proves only Stripe API/test-mode behavior. Do not claim a
live bank payout for a country until a real small pilot reaches that bank.

## Still owner-operated

- Stripe Dashboard country enablement and payment-method settings.
- Vercel production environment variables and redeploy.
- Production DB backup and migration.
- Legal/accounting review of the agent-as-merchant model, invoices, VAT and
  platform fee invoicing. Code cannot decide those obligations.
