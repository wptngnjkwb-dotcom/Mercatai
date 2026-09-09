# Stripe Connect onboarding — Norway support technical note

Prepared while removing a hardcoded `business_type: 'company'` from Stripe
Connect Express account creation (`frontend/app/api/v1/agents/[id]/stripe-onboard/route.ts`)
and preparing Mercatai (a Czech platform) to onboard a Norwegian agent.
Sources are official Stripe documentation and Stripe's own live
onboarding-requirements data, linked below.

## Conclusion

**Norway is supported by Stripe and Mercatai accepts `NO` as part of its
EU/EEA onboarding country set, but the complete CZ-platform → NO-connected-account flow with
`on_behalf_of` has not yet been validated by creating a Stripe test account
and completing card/SEPA PaymentIntents.**

This is deliberately narrower than "Norwegian sole proprietors are
supported end-to-end." What has actually been checked, and what has not,
are kept separate below.

## What has been checked (and how)

- [`docs.stripe.com/connect/express-accounts`](https://docs.stripe.com/connect/express-accounts):
  `business_type` is optional on `accounts.create` — Stripe's own hosted
  onboarding can collect it directly from the account holder instead of
  the platform prefilling it. This is why the code no longer hardcodes
  `'company'`.
- `GET https://docs.stripe.com/_endpoint/get-platform-countries`: confirms
  `NO` is a valid Stripe platform/connected-account country (54 countries
  returned, `NO` among them).
- `GET https://docs.stripe.com/_endpoint/get-requirement-selections-for-platform-country?platformCountry=CZ`:
  confirms `NO` is a valid `accountCountry` for a Czech platform, and that
  Norway's `entity_type_structures` includes `individual` as a legal-entity
  type option (alongside `company`, `non_profit`, etc.) — i.e. `individual`
  is *an available choice for Norway*, not that it is the correct or only
  choice for any particular Norwegian agent.
- `GET https://docs.stripe.com/_endpoint/get-requirements-for-setups` with
  `platformCountry=CZ, accountCountry=NO, dashboardType=express,
  legalEntityType=individual, capabilities=[card_payments,transfers]`:
  returned zero `validation_errors` and zero `build_errors`, and listed the
  fields Stripe would require (business_profile.mcc/url, individual name/
  address/dob/phone/email, tos_acceptance, external_account).

**What this endpoint actually confirms:** that this specific combination of
inputs is a well-formed, internally-consistent onboarding *configuration*
Stripe's own requirements engine accepts — i.e. preliminary input
compatibility. **It does not confirm** that a real Stripe account was
created, that Connect's cross-border transfer rules accept a live payout in
this configuration, or that a real card/SEPA PaymentIntent using
`on_behalf_of` actually settles into a Norwegian connected account. No live
Stripe account, PaymentIntent, or other external Stripe object has been
created as part of this work.

## `business_type` — do not assume `individual`

Stripe's own account-creation flow treats `business_type` as something
**the account holder confirms during onboarding**, even when a platform
prefills it. Mercatai's code now leaves `business_type` unset by default,
letting Stripe's hosted onboarding ask the agent directly. If a caller
supplies one explicitly, the API accepts any of Stripe's four values
(`individual`, `company`, `non_profit`, `government_entity`) — Mercatai
does not infer or default a Norwegian agent to `individual` on their
behalf. A Norwegian sole proprietorship (enkeltpersonforetak) is commonly
`individual`, but the actual legal form is the account holder's own
determination, made in Stripe's hosted UI, not Mercatai's assumption.

## Open, unresolved nuance: `on_behalf_of` and cross-border payouts

`docs.stripe.com/connect/cross-border-payouts` states that its supported
funds flows include "Destination charges … without `on_behalf_of`" — and
Mercatai's `create-intent/route.ts` uses `on_behalf_of` together with
`transfer_data.destination`. The same page also prices "within the EEA"
transfers under this product, which suggests intra-EEA transfers (Czech
Republic → Norway, both EEA) may fall under this product's scope and
therefore under this same limitation — but this has not been confirmed
either way against Stripe support or by an actual test transaction. This is
the central reason the conclusion above stops at "not yet validated" rather
than asserting the full flow works.

## Recommended next step (needs explicit permission before any Stripe object is created)

Create a **test-mode** Stripe Connect Express account with `country: 'NO'`
on a test platform account, and attempt both a test card PaymentIntent and
a test SEPA Direct Debit PaymentIntent using the exact `on_behalf_of` +
`transfer_data.destination` shape `create-intent/route.ts` uses. That is
the only way to resolve the `on_behalf_of` cross-border nuance above with
certainty, short of asking Stripe support directly.
