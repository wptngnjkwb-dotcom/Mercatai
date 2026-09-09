# Stripe Connect country support

Last reviewed: 2026-09-09

Mercatai accepts Stripe Connect Express onboarding for the countries listed by
`frontend/lib/onboardingCountries.ts`. The list follows Stripe's documented
Express connected-account availability, not its broader list of countries from
which a customer can make a card payment.

Primary Stripe references:

- https://docs.stripe.com/connect/accounts
- https://docs.stripe.com/connect/express-accounts
- https://docs.stripe.com/connect/account-capabilities
- https://docs.stripe.com/connect/destination-charges

## Capability profiles

Per-country `supportsSepaDebit` — not region — is what actually decides
whether `sepa_debit_payments` is requested. Two independent Stripe sources
were checked against each other on 2026-09-09, and they disagree at the
edges:

- 26 of the 27 EU member states, plus Norway, request `card_payments`,
  `sepa_debit_payments`, and `transfers`. **Croatia is excluded entirely** —
  it has no Stripe Express connected-account availability at all
  ([docs.stripe.com/connect/accounts](https://docs.stripe.com/connect/accounts)),
  so onboarding a Croatian account isn't possible regardless of payment
  method.
- **Iceland** has Express availability but requests only `card_payments` and
  `transfers` — it's absent from Stripe's SEPA Direct Debit business-location
  list ([docs.stripe.com/payments/sepa-debit](https://docs.stripe.com/payments/sepa-debit?pm-info=business-locations)),
  so requesting `sepa_debit_payments` for it would ask Stripe for a
  capability it won't grant.
- **Liechtenstein** is excluded entirely, for the same reason as Croatia — no
  Stripe Express connected-account availability.
- Every other country in Stripe's Express connected-account list requests
  only `card_payments` and `transfers`. Some of these (e.g. Switzerland, the
  UK, Japan) do appear on Stripe's SEPA business-location list, but Mercatai
  deliberately keeps SEPA to EU/EEA accounts for now rather than requesting
  it globally — see the comment on `requiredCapabilitiesForCountry` in
  `frontend/lib/onboardingCountries.ts`. That's a scope decision, not a
  factual claim those countries can't do SEPA; broadening it would need its
  own review of settlement-currency and practical-usefulness questions.

Mercatai intentionally does not request `sepa_debit_payments` for every global
account. Stripe documents payment-method capabilities as country-dependent;
requesting an unavailable capability can block an otherwise valid onboarding.

## What inclusion in the selector means

Inclusion means that Mercatai permits an onboarding attempt for that country.
It is not a promise that a particular person, legal form, bank account, or
business activity will be approved. Stripe makes that decision during hosted
onboarding and can require more information, keep a capability pending, reject
it, or restrict it later.

Mercatai does not create a buyer payment until a live Stripe Account lookup
confirms all of the following:

- identity onboarding is complete;
- there are no outstanding requirements;
- payouts are enabled;
- transfers are active;
- the capability for the requested payment method is active; and
- charges are enabled.

For a non-EU/EEA connected account, a buyer request for SEPA Direct Debit is
rejected before a PaymentIntent is created and the API returns card as the
supported alternative.

## Operational requirements

Stripe can require additional countries to be enabled in the platform's
Connect settings. Country availability, cross-border settlement, supported
bank-account formats, settlement currencies, foreign-exchange fees, tax
reporting, and business eligibility remain country-specific.

Before Mercatai publicly describes a country as tested end-to-end, complete a
test-mode onboarding and card payment/refund flow using the production request
shape. Before describing bank payout as proven, complete a small live payment
and payout to a real account in that country. Stripe notes that test mode does
not enforce every capability restriction, so a passing mock or sandbox test is
not proof of a real bank payout.

The older `docs/stripe-norway-onboarding.md` records the narrower Norway review
that preceded this general country model. Its caution about the untested live
payout remains applicable until that test is completed.
