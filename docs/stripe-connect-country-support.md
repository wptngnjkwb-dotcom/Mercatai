# Stripe Connect country support

Last reviewed: 2026-10-06.

Mercatai separates two concepts:

1. `frontend/lib/onboardingCountries.ts` is Mercatai's verified Stripe
   Connect catalog and per-country SEPA capability profile.
2. `STRIPE_CONNECT_ENABLED_COUNTRIES` is the runtime allowlist this
   Mercatai platform publicly offers.

The selector, OpenAPI and discovery JSON all use the same runtime list.
Unknown codes are ignored, and payment creation still performs a live Stripe
readiness check.

## Current EU/EEA + UK default

The Standard/full-dashboard default is all 27 EU countries, Liechtenstein,
Norway and the United Kingdom (30 countries). Croatia and Liechtenstein are
Standard-capable even though Stripe's legacy Express catalog excluded them.
Iceland is Express-only in this integration and is therefore not offered for
new ordinary onboarding. All countries in the Standard default support card
and SEPA Direct Debit subject to Stripe's live capability decision.

Stripe source for SEPA business locations:
https://docs.stripe.com/payments/sepa-debit

Stripe source for Standard/full-dashboard markets:
https://stripe.com/global

## Direct Charge capability profile

New payments are Direct Charges in the connected account. The default
onboarding creates a Standard/full-dashboard account and asks for:

- `card_payments` for every enabled account;
- `sepa_debit_payments` only where `supportsSepaDebit` is true.

Standard accounts do not request `transfers`. The three explicitly migrated
€3 pilots are the only exception: their assigned agent receives a
task-scoped Express onboarding flow, where Stripe requires `transfers` to be
requested alongside `card_payments`. There is no public account-type switch
and a client-supplied Express value cannot enable it. A live
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
account. Mercatai receives its application fee. On the default Standard
account, Stripe charges its own processing, FX, dispute, refund and payout
fees to the connected account and Stripe's agreement with the account holder
governs negative balances. The three task-labelled Express pilots retain the
platform fee/loss-collector configuration for those pilots only.

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
