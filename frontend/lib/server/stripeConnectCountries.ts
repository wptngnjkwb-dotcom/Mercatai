import { getOnboardingCountry, onboardingCountryGroups, type OnboardingCountry } from '@/lib/onboardingCountries'

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
const DEFAULT_ENABLED_COUNTRY_CODES = ['CZ', 'DE', 'NO'] as const

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
    console.error('STRIPE_CONNECT_ENABLED_COUNTRIES resolved to zero valid countries — falling back to the conservative default (CZ, DE, NO)')
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
