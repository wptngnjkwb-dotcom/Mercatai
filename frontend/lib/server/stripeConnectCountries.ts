import { getOnboardingCountry, onboardingCountryGroups, SUPPORTED_ONBOARDING_COUNTRIES, type OnboardingCountry } from '@/lib/onboardingCountries'

/**
 * Countries Mercatai actually offers today — distinct from the full
 * catalog in lib/onboardingCountries.ts, which only tracks what Stripe
 * *documents* as Express-supported. Being in that catalog does not mean
 * this specific Stripe platform account has it turned on: Stripe Connect
 * onboarding options (Dashboard → Settings → Connect → Onboarding options →
 * Countries) are configured per platform account and can lag or
 * deliberately narrow the documented set — see docs/stripe-connect-country-support.md
 * for the incident that prompted this split (accounts.create() failing with
 * "<country> is not currently supported by Stripe" for catalog-valid codes
 * the platform hadn't enabled).
 *
 * Server-only: reads process.env.STRIPE_CONNECT_ENABLED_COUNTRIES, so this
 * must never be imported by a client component (unlike onboardingCountries.ts,
 * which has no env dependency and is safe for both). The public onboarding
 * page fetches the resolved list from GET /api/v1/onboarding-countries
 * instead of importing this module directly.
 *
 * Read fresh on every call rather than cached at module scope, so a changed
 * env var takes effect without a rebuild and tests can vary it per case.
 */
// Direct Charges remove the prior cross-border on_behalf_of constraint.
// Hosted onboarding and live capability/payout checks still fail closed for
// each individual account before any buyer payment can be created.
const DEFAULT_ENABLED_COUNTRY_CODES = SUPPORTED_ONBOARDING_COUNTRIES
  .filter(country => country.region === 'eu' || country.region === 'eea' || country.code === 'GB')
  .map(country => country.code)

function parseEnabledCountryCodes(): string[] {
  const raw = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES

  if (!raw || !raw.trim()) return [...DEFAULT_ENABLED_COUNTRY_CODES]

  const candidates = raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  for (const code of candidates) {
    if (getOnboardingCountry(code)) valid.push(code)
    else invalid.push(code)
  }
  // ISO codes only — never log the raw env value itself, in case a
  // misconfigured deploy ever concatenates it with something sensitive.
  if (invalid.length > 0) {
    console.error(`STRIPE_CONNECT_ENABLED_COUNTRIES has unknown country code(s), ignored: ${invalid.join(', ')}`)
  }

  const unique = Array.from(new Set(valid))
  if (unique.length === 0) {
    console.error('STRIPE_CONNECT_ENABLED_COUNTRIES resolved to zero valid countries — falling back to the EU/EEA + UK Direct Charges rollout set')
    return [...DEFAULT_ENABLED_COUNTRY_CODES]
  }
  return unique
}

/** ISO codes Mercatai currently permits *starting* onboarding for. Does not imply payouts have been end-to-end verified for any of them — see isMethodReady/computeStripeAccountReadiness for the live, per-account check that actually gates a payment. */
export function getEnabledOnboardingCountryCodes(): string[] {
  return parseEnabledCountryCodes()
}

export function getEnabledOnboardingCountries(): OnboardingCountry[] {
  return parseEnabledCountryCodes()
    .map((code) => getOnboardingCountry(code))
    .filter((c): c is OnboardingCountry => !!c)
}

export function isOnboardingCountryEnabled(code: string): boolean {
  return parseEnabledCountryCodes().includes(code.toUpperCase())
}

/** Same grouping shape as onboardingCountryGroups(), filtered to enabled countries and with any now-empty group dropped. */
export function getEnabledOnboardingCountryGroups(): Array<{ label: string; countries: OnboardingCountry[] }> {
  const enabled = new Set(parseEnabledCountryCodes())
  return onboardingCountryGroups()
    .map((group) => ({ label: group.label, countries: group.countries.filter((c) => enabled.has(c.code)) }))
    .filter((group) => group.countries.length > 0)
}

/**
 * STRIPE_DIRECT_CHARGE_COUNTRIES — a SEPARATE, deliberately fail-closed
 * allowlist gating whether a NEW payment may actually be created as a
 * Direct Charge for a connected account in a given country. This is not
 * the same list as STRIPE_CONNECT_ENABLED_COUNTRIES above: that one only
 * gates *starting onboarding* (registration) — being on it has never been
 * a promise that Mercatai will actually accept a payment for that
 * country's agents yet. Before this gate existed, POST
 * /api/v1/payments/create-intent created a Direct Charge for ANY
 * connected account with a completed Stripe onboarding, regardless of
 * country, the moment migration 21 shipped — this closes that gap.
 *
 * Unlike parseEnabledCountryCodes, this NEVER falls back to a broad
 * default when unset or when every supplied code is invalid — it
 * resolves to an EMPTY list instead. An unconfigured deployment must
 * permit zero countries for Direct Charge payment creation, not silently
 * inherit the onboarding rollout list. See isDirectChargeCountryEnabled's
 * caller in create-intent/route.ts for how a disallowed country is
 * refused outright rather than ever falling back to the legacy
 * destination-charge model.
 */
function parseDirectChargeCountryCodes(): string[] {
  const raw = process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
  if (!raw || !raw.trim()) return []

  const candidates = raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  for (const code of candidates) {
    if (getOnboardingCountry(code)) valid.push(code)
    else invalid.push(code)
  }
  // ISO codes only — never log the raw env value itself.
  if (invalid.length > 0) {
    console.error(`STRIPE_DIRECT_CHARGE_COUNTRIES has unknown country code(s), ignored: ${invalid.join(', ')}`)
  }
  return Array.from(new Set(valid))
}

/** ISO codes Mercatai currently permits creating a NEW Direct Charge payment for. Deliberately separate from, and never wider than, onboarding enablement. */
export function getDirectChargeEnabledCountryCodes(): string[] {
  return parseDirectChargeCountryCodes()
}

export function isDirectChargeCountryEnabled(code: string): boolean {
  return parseDirectChargeCountryCodes().includes(code.toUpperCase())
}

/**
 * The ONE function that should ever gate an actual Direct Charge payment
 * attempt — true only when the connected account's country is enabled for
 * BOTH onboarding AND Direct Charges. isDirectChargeCountryEnabled alone
 * is deliberately NOT sufficient for that: STRIPE_CONNECT_ENABLED_COUNTRIES
 * and STRIPE_DIRECT_CHARGE_COUNTRIES are independent env vars, so a country
 * could be listed in the latter while having been removed from (or never
 * added to) the former — e.g. an operator error, or a country whose
 * onboarding was later disabled without anyone touching the payment list.
 * That must never leave a live payment path open for it. Matches
 * getPaymentEnabledCountryCodes()'s own intersection semantics exactly —
 * this is the single-code equivalent, meant for a hot-path check that
 * doesn't need the full list materialized.
 */
export function isPaymentCountryEnabled(code: string): boolean {
  const upper = code.toUpperCase()
  return isOnboardingCountryEnabled(upper) && isDirectChargeCountryEnabled(upper)
}

/**
 * A country is publicly describable as "payments enabled" only when it is
 * enabled for BOTH onboarding (registration) AND Direct Charge payment
 * creation — being in only one of the two lists must never be reported as
 * payment support. See docs/stripe-connect-country-support.md.
 */
export function getPaymentEnabledCountryCodes(): string[] {
  const onboardingEnabled = new Set(parseEnabledCountryCodes())
  return parseDirectChargeCountryCodes().filter((code) => onboardingEnabled.has(code))
}
