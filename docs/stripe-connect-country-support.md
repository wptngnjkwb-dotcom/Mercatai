# Stripe Connect country support

Last reviewed: 2026-09-22.

Mercatai separates two concepts:

1. `frontend/lib/onboardingCountries.ts` is the documented Stripe Express
   catalog and per-country SEPA capability profile.
2. `STRIPE_CONNECT_ENABLED_COUNTRIES` is the runtime allowlist this
   Mercatai platform publicly offers.

The selector, OpenAPI and discovery JSON all use the same runtime list.
Unknown codes are ignored, and payment creation still performs a live Stripe
readiness check.

## Current EU/EEA + UK default

The default is 26 EU countries (Croatia excluded), Iceland, Norway and the
United Kingdom. Liechtenstein is also excluded from this application's
verified Express catalog. Iceland is card-only; GB is card + SEPA.

Stripe source for SEPA business locations:
https://docs.stripe.com/payments/sepa-debit

## Direct Charge capability profile

New payments are Direct Charges in the connected account. Onboarding asks
for:

- `card_payments` for every enabled account;
- `sepa_debit_payments` only where `supportsSepaDebit` is true.

The old `transfers` capability is not required for Direct Charges. A live
payment requires the selected payment capability, `charges_enabled` and
`payouts_enabled`; identity details and Stripe requirements must also be
complete. These checks run again before every PaymentIntent is created or
reused.

## What inclusion means

Inclusion permits an onboarding attempt. Stripe can still request additional
information, keep a capability pending, reject an application, restrict an
account later, or reject the bank account. Mercatai must never describe a
country as bank-payout verified solely because it appears in the selector.

## Charge ownership and fees

For a Direct Charge, the PaymentIntent and Charge belong to the connected
account. Mercatai receives its application fee. Stripe's own processing, FX,
dispute, refund and payout fees follow the connected account/controller
configuration and can reduce the final bank payout independently of
Mercatai's fees.

Existing pre-migration destination charges are permanently tagged as
`destination` and continue to use the platform account. New transactions
freeze `direct` plus the connected account id before Stripe object creation;
that context cannot be changed later.

## Verification standard

Before calling a country end-to-end tested, complete hosted onboarding and a
real test-mode card/refund flow using the production request shape; test SEPA
success/failure/refund when advertised. Before claiming bank payout support
as proven, complete a small live payment and bank payout in that country.

See `docs/eu-payments-rollout.md` and
`docs/migration-21-direct-charges-runbook.md` for operational steps.
