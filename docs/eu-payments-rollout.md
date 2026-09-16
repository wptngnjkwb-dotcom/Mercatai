# EU-wide payments rollout — groundwork

Last reviewed: 2026-09-16. Companion to `docs/stripe-connect-country-support.md`
(the country-support architecture and its rationale) — this document is the
concrete, EU-scoped checklist for turning that architecture on more broadly.
It changes nothing in code: the app is already fully country-parameterized
(see "What's already true" below). Enabling more countries is a Stripe
Dashboard + Vercel environment-variable change, not a deploy.

## Charge-model decision (2026-09-16) — this rollout does NOT change it

For the first paid pilots, Mercatai keeps the current **destination charge
with `on_behalf_of`** architecture (`transfer_data.destination` +
`on_behalf_of` on the PaymentIntent — see `frontend/app/api/v1/payments/
create-intent/route.ts`). A prior draft of this document argued this was
unsupported for cross-border payouts; that was a misreading. Per Stripe's
own current docs (`/connect/account-capabilities` — "Cross-border
transfers"), the EEA is treated as **one single region** for cross-border
transfer purposes — a Czech platform paying a connected account anywhere
else in the EU/EEA is not a cross-border transfer at all in Stripe's
sense, and the current architecture is not blocked by it. Switching to
Direct charges remains a possible *long-term* direction (see the separate
charge-model decision memorandum from this engagement), but is explicitly
**not** part of this rollout — expanding to more EU countries under the
current charge model requires no charge-model change, only the
Stripe-side enablement and verification steps below.

## Publicly enabled countries today: CZ, DE, NO only

**No other country is published anywhere** (UI, OpenAPI, discovery JSON,
`STRIPE_CONNECT_ENABLED_COUNTRIES`) as of this rollout. Adding a country
to any single one of those surfaces without the other three, or without
completing the verification gate below, is exactly the kind of
inconsistency `docs/stripe-connect-country-support.md`'s "Catalog vs.
enabled" section already warns against — a country must never be
publicly offered as available before it has actually been turned on and
verified. **Next priority: France (FR)** — see "Recommended rollout
order" below; every other Eurozone country follows after FR, not before.

### The four-part gate — all four required before ANY country is published

A country is not "enabled" until **all four** of the following are true.
Completing only the UI/code side (which is already generic and needs no
per-country change) is explicitly **not** sufficient:

1. **Stripe Dashboard enablement** — Settings → Connect → Onboarding
   options → Countries, in live mode, for this specific platform account.
2. **Environment configuration** — the country's ISO code added to
   `STRIPE_CONNECT_ENABLED_COUNTRIES` in Vercel (Production), which is
   what `frontend/lib/server/stripeConnectCountries.ts` actually reads at
   runtime — Dashboard enablement alone does not change what Mercatai's
   own code will let an agent select.
3. **Test-mode onboarding pass** — a real hosted Express onboarding
   completed in Stripe test mode for that country, confirming Stripe
   actually accepts it end-to-end for this platform account (not just
   that it's in the general catalog).
4. **Capabilities + a real payment/payout test** — `card_payments`
   (+ `sepa_debit_payments` where applicable) active on a test account for
   that country, and at least one test-mode card authorize → capture →
   release pass (plus SEPA if claiming SEPA support) — see
   `docs/stripe-connect-country-support.md`'s own required checklist
   before publicly describing a country as tested end-to-end.

## What's already true (no code change needed)

- `frontend/lib/onboardingCountries.ts` documents Express + SEPA
  availability for **26 of the 27 EU member states** (all but Croatia,
  which Stripe does not support for Express accounts at all) **plus
  Norway and Iceland** (Iceland: card only, no SEPA) — 28 EU/EEA countries
  total, cross-checked against Stripe's own docs on 2026-09-09.
- Per-country required capabilities (`card_payments` + `transfers`,
  `sepa_debit_payments` added only where Stripe actually supports it) are
  already correctly modeled — see `requiredCapabilitiesForCountry`.
- The country selector (`GET /api/v1/onboarding-countries`), the OpenAPI
  spec, and the discovery JSON all already read from the same live
  enabled-list — no separate surface to update when the list changes.
- Payment readiness (`computeStripeAccountReadiness`) is always derived
  from a live Stripe Account lookup, never a stored flag — this doesn't
  change per country.

## What's actually missing: enablement, not capability

`STRIPE_CONNECT_ENABLED_COUNTRIES` in production currently falls back to
its conservative default, `CZ,DE,NO` (confirmed live: production's
Connect webhook and onboarding flow both currently behave as if only
these three are enabled). The other 25 EU/EEA catalog countries are
architecturally ready but not turned on. Full EU/EEA value to set once
the Stripe-side steps below are done:

```
STRIPE_CONNECT_ENABLED_COUNTRIES=AT,BE,BG,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,IS,NO
```

(26 EU member states minus Croatia, plus Iceland and Norway — the exact
set `frontend/lib/onboardingCountries.ts` documents as Stripe
Express-capable. Croatia and Liechtenstein are not included because
Stripe does not support Express accounts there at all — this is a Stripe
platform constraint, not a Mercatai choice; revisit only if Stripe adds
support.)

## Before setting that value — Stripe Dashboard steps (owner-only)

1. **Live mode** (this changes what real agents can select — do this in
   live mode, not test mode).
2. **Settings → Connect → Onboarding options → Countries.** Stripe's
   documented Express availability (what the catalog reflects) is
   separate from what *this platform account* has actually turned on —
   see "Catalog vs. enabled" in `docs/stripe-connect-country-support.md`
   for the exact incident that made this distinction necessary. Enable
   each of the 28 EU/EEA countries listed above that isn't already
   checked.
3. Stripe may ask for additional platform-level information before
   allowing some countries (e.g. tax/compliance attestations) — this is
   normal and specific to the platform account, not something Mercatai's
   code can pre-empt.

## Recommended rollout order — do not flip all 28 at once

The existing country-support doc is explicit: *"Before Mercatai publicly
describes a country as tested end-to-end, complete a test-mode onboarding
and card payment/refund flow using the production request shape."* Of the
28 EU/EEA countries, only **Germany and Norway** have actually been
through that full pass (hosted onboarding, card authorize/capture/refund,
SEPA success/failure, simulated payout — see the DE/NO verification
matrix from the Stripe Connect hardening work). Every other EU/EEA country
is catalog-correct but unverified against Mercatai's specific
destination-charge (`on_behalf_of` + `transfer_data.destination`) flow.

Suggested phased order, batching by what's most likely to surface a real
issue first:

0. **France (FR) first, on its own** — not bundled with the rest of
   phase 1. Complete the full four-part gate above for FR alone, verify
   it live with a real (or first) pilot transaction, and only then move
   to the rest of phase 1. Called out separately because it's currently
   this rollout's stated next priority.
1. **Phase 1 — remaining Eurozone, SEPA-capable, large agent pools
   likely** (settle in EUR, so no payout-currency conversion to reason
   about): IT, ES, NL, BE, AT, IE, PT, FI. Test-mode pass per the existing
   doc's checklist before enabling each live, or accept and document the
   risk of enabling on catalog-correctness alone (not recommended for the
   first few — that's exactly the gap the Croatia/Iceland/Peru incident
   in the country-support doc came from).
2. **Phase 2 — remaining Eurozone**: GR, LU, MT, CY, SK, SI, LV, LT, EE.
   Same shape as phase 1 (EUR settlement, SEPA-capable) — lower priority
   only because they're smaller markets, not higher risk.
3. **Phase 3 — non-Eurozone EU (own settlement currency)**: SE (SEK), DK
   (DKK), PL (PLN), HU (HUF), RO (RON), BG (BGN). Mercatai's own pricing
   and transactions stay EUR (buyer-side card charges work in EUR
   regardless of the cardholder's country), but Stripe payouts to these
   connected accounts settle in the account's own bank currency by
   default — an agent here sees FX-converted payouts, at Stripe's rate,
   not raw EUR amounts. Not a blocking technical issue, but worth a
   one-line disclosure on the onboarding page for these countries before
   enabling them (`frontend/lib/onboardingCountries.ts` already tracks
   these separately enough to add a per-country note if needed).
4. **Iceland** last, and flagged distinctly in the UI as card-only — it's
   the one EU/EEA catalog country without SEPA, so an Icelandic agent's
   buyer never sees a SEPA option, only card.

## Explicitly out of scope for this document

- No live Stripe objects were created while preparing this — it is pure
  documentation and configuration guidance, per this task's boundaries.
- No code, migration, or deployment change is required to enable more
  countries — this is `STRIPE_CONNECT_ENABLED_COUNTRIES` (Vercel) and the
  Connect onboarding-options allowlist (Stripe Dashboard) only, and both
  remain the account owner's own action, done deliberately per phase
  above rather than all at once.
- Tax treatment (VAT/OSS, invoicing obligations across member states) is
  explicitly not addressed here — see the "Hranice" note in this same
  engagement's task boundaries: automatic tax invoicing is intentionally
  not implemented until confirmed with an accountant, and that applies
  identically across every EU country, not just the ones already enabled.
