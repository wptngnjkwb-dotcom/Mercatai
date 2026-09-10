/**
 * Countries in which Stripe documents Express connected-account
 * availability. This is intentionally the Connect/Express list, not
 * ordinary Stripe merchant availability: Mercatai needs a connected payout
 * account. Cross-checked against two separate, independent Stripe sources
 * on 2026-09-09:
 *   - Express connected-account availability: https://docs.stripe.com/connect/accounts
 *   - SEPA Direct Debit business-location availability: https://docs.stripe.com/payments/sepa-debit?pm-info=business-locations
 * The two lists disagree at the edges — see the per-country notes below —
 * which is exactly why `supportsSepaDebit` is tracked per country instead
 * of being inferred from `region`. Stripe remains the final authority at
 * account-creation time. Payment creation stays fail-closed until
 * capabilities and payouts are live.
 */

export type OnboardingRegion = 'eu' | 'eea' | 'stripe_connect'

export interface OnboardingCountry {
  code: string
  label: string
  region: OnboardingRegion
  /**
   * Decided per country, not inferred from `region` — Iceland is 'eea' but
   * false (no Stripe SEPA business-location support); every other EU/EEA
   * country is true. See the per-country comments on EU_COUNTRIES and
   * EEA_COUNTRIES below.
   */
  supportsSepaDebit: boolean
}

export interface RequiredStripeCapabilities {
  card_payments: { requested: true }
  transfers: { requested: true }
  sepa_debit_payments?: { requested: true }
}

const EU_COUNTRIES: readonly OnboardingCountry[] = [
  { code: 'AT', label: 'Austria', region: 'eu', supportsSepaDebit: true },
  { code: 'BE', label: 'Belgium', region: 'eu', supportsSepaDebit: true },
  { code: 'BG', label: 'Bulgaria', region: 'eu', supportsSepaDebit: true },
  // Croatia is an EU member state but is NOT in Stripe's documented Express
  // connected-account availability list (checked 2026-09-09) — creating an
  // Express account with country: 'HR' fails at Stripe's API. Do not add it
  // back without first confirming Stripe has added Express support for HR.
  { code: 'CY', label: 'Cyprus', region: 'eu', supportsSepaDebit: true },
  { code: 'CZ', label: 'Czech Republic', region: 'eu', supportsSepaDebit: true },
  { code: 'DK', label: 'Denmark', region: 'eu', supportsSepaDebit: true },
  { code: 'EE', label: 'Estonia', region: 'eu', supportsSepaDebit: true },
  { code: 'FI', label: 'Finland', region: 'eu', supportsSepaDebit: true },
  { code: 'FR', label: 'France', region: 'eu', supportsSepaDebit: true },
  { code: 'DE', label: 'Germany', region: 'eu', supportsSepaDebit: true },
  { code: 'GR', label: 'Greece', region: 'eu', supportsSepaDebit: true },
  { code: 'HU', label: 'Hungary', region: 'eu', supportsSepaDebit: true },
  { code: 'IE', label: 'Ireland', region: 'eu', supportsSepaDebit: true },
  { code: 'IT', label: 'Italy', region: 'eu', supportsSepaDebit: true },
  { code: 'LV', label: 'Latvia', region: 'eu', supportsSepaDebit: true },
  { code: 'LT', label: 'Lithuania', region: 'eu', supportsSepaDebit: true },
  { code: 'LU', label: 'Luxembourg', region: 'eu', supportsSepaDebit: true },
  { code: 'MT', label: 'Malta', region: 'eu', supportsSepaDebit: true },
  { code: 'NL', label: 'Netherlands', region: 'eu', supportsSepaDebit: true },
  { code: 'PL', label: 'Poland', region: 'eu', supportsSepaDebit: true },
  { code: 'PT', label: 'Portugal', region: 'eu', supportsSepaDebit: true },
  { code: 'RO', label: 'Romania', region: 'eu', supportsSepaDebit: true },
  { code: 'SK', label: 'Slovakia', region: 'eu', supportsSepaDebit: true },
  { code: 'SI', label: 'Slovenia', region: 'eu', supportsSepaDebit: true },
  { code: 'ES', label: 'Spain', region: 'eu', supportsSepaDebit: true },
  { code: 'SE', label: 'Sweden', region: 'eu', supportsSepaDebit: true },
]

const EEA_COUNTRIES: readonly OnboardingCountry[] = [
  // Iceland has Express connected-account availability but is NOT in
  // Stripe's SEPA Direct Debit business-location list — an Icelandic
  // account can onboard, but only for card payments.
  { code: 'IS', label: 'Iceland', region: 'eea', supportsSepaDebit: false },
  // Liechtenstein, unlike Iceland, has no Express connected-account
  // availability at all (checked 2026-09-09) — same exclusion reason as
  // Croatia above.
  { code: 'NO', label: 'Norway', region: 'eea', supportsSepaDebit: true },
]

const OTHER_STRIPE_CONNECT_COUNTRIES: readonly OnboardingCountry[] = [
  { code: 'AL', label: 'Albania', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'AG', label: 'Antigua & Barbuda', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'AM', label: 'Armenia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'AR', label: 'Argentina', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'AU', label: 'Australia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BS', label: 'Bahamas', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BH', label: 'Bahrain', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BJ', label: 'Benin', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BO', label: 'Bolivia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BA', label: 'Bosnia & Herzegovina', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BW', label: 'Botswana', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'BN', label: 'Brunei', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'KH', label: 'Cambodia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'CA', label: 'Canada', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'CL', label: 'Chile', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'CO', label: 'Colombia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'CR', label: 'Costa Rica', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'CI', label: 'Côte d’Ivoire', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'DO', label: 'Dominican Republic', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'EC', label: 'Ecuador', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'EG', label: 'Egypt', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'SV', label: 'El Salvador', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'ET', label: 'Ethiopia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'GM', label: 'Gambia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'GH', label: 'Ghana', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'GT', label: 'Guatemala', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'GY', label: 'Guyana', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'HK', label: 'Hong Kong', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'IL', label: 'Israel', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'JM', label: 'Jamaica', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'JP', label: 'Japan', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'JO', label: 'Jordan', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'KE', label: 'Kenya', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'KW', label: 'Kuwait', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MO', label: 'Macao', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MG', label: 'Madagascar', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MU', label: 'Mauritius', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MX', label: 'Mexico', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MD', label: 'Moldova', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MC', label: 'Monaco', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MN', label: 'Mongolia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MA', label: 'Morocco', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'NA', label: 'Namibia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'NZ', label: 'New Zealand', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'NG', label: 'Nigeria', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'MK', label: 'North Macedonia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'OM', label: 'Oman', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'PK', label: 'Pakistan', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'PA', label: 'Panama', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'PY', label: 'Paraguay', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'PE', label: 'Peru', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'PH', label: 'Philippines', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'QA', label: 'Qatar', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'RW', label: 'Rwanda', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'SA', label: 'Saudi Arabia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'SN', label: 'Senegal', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'RS', label: 'Serbia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'SG', label: 'Singapore', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'ZA', label: 'South Africa', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'KR', label: 'South Korea', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'LK', label: 'Sri Lanka', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'LC', label: 'St. Lucia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'CH', label: 'Switzerland', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'TW', label: 'Taiwan', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'TZ', label: 'Tanzania', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'TH', label: 'Thailand', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'TT', label: 'Trinidad & Tobago', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'TN', label: 'Tunisia', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'TR', label: 'Turkey', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'AE', label: 'United Arab Emirates', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'GB', label: 'United Kingdom', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'US', label: 'United States', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'UY', label: 'Uruguay', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'UZ', label: 'Uzbekistan', region: 'stripe_connect', supportsSepaDebit: false },
  { code: 'VN', label: 'Vietnam', region: 'stripe_connect', supportsSepaDebit: false },
]

export const SUPPORTED_ONBOARDING_COUNTRIES: readonly OnboardingCountry[] = [
  ...EU_COUNTRIES,
  ...EEA_COUNTRIES,
  ...OTHER_STRIPE_CONNECT_COUNTRIES,
]

export const SUPPORTED_ONBOARDING_COUNTRY_CODES = SUPPORTED_ONBOARDING_COUNTRIES.map((country) => country.code)

const COUNTRY_BY_CODE = new Map(SUPPORTED_ONBOARDING_COUNTRIES.map((country) => [country.code, country]))

export function getOnboardingCountry(code: string): OnboardingCountry | undefined {
  return COUNTRY_BY_CODE.get(code)
}

export function isSupportedOnboardingCountry(code: string): boolean {
  return COUNTRY_BY_CODE.has(code)
}

export function requiredCapabilitiesForCountry(code: string): RequiredStripeCapabilities | null {
  const country = getOnboardingCountry(code)
  if (!country) return null

  return {
    card_payments: { requested: true },
    ...(country.supportsSepaDebit ? { sepa_debit_payments: { requested: true as const } } : {}),
    transfers: { requested: true },
  }
}

export function onboardingCountryGroups(): Array<{ label: string; countries: readonly OnboardingCountry[] }> {
  return [
    { label: 'European Union', countries: EU_COUNTRIES },
    { label: 'EEA (outside the EU)', countries: EEA_COUNTRIES },
    { label: 'Other Stripe Connect countries', countries: OTHER_STRIPE_CONNECT_COUNTRIES },
  ]
}
