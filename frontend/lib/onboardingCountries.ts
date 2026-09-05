/**
 * Countries Mercatai currently accepts for Stripe Connect Express
 * onboarding — deliberately small, not a stand-in for the full ISO 3166-1
 * list. Add a country here only after checking it against Stripe's own
 * onboarding-requirements data (docs.stripe.com's platform-country and
 * requirements-for-setups endpoints), the way CZ and NO were checked — see
 * docs/stripe-norway-onboarding.md. Shared between the onboarding UI
 * (the <select> options) and the server route (the same list is the
 * validation source of truth), so the two can never drift apart.
 */
export const SUPPORTED_ONBOARDING_COUNTRIES = [
  { code: 'CZ', label: 'Czech Republic' },
  { code: 'NO', label: 'Norway' },
] as const

export type SupportedOnboardingCountryCode = (typeof SUPPORTED_ONBOARDING_COUNTRIES)[number]['code']

export function isSupportedOnboardingCountry(code: string): code is SupportedOnboardingCountryCode {
  return SUPPORTED_ONBOARDING_COUNTRIES.some((c) => c.code === code)
}
