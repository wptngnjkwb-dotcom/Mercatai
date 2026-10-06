/**
 * Countries in which Stripe documents at least one connected-account model.
 * Standard/full-dashboard and legacy Express availability are deliberately
 * tracked separately: Croatia and Liechtenstein support ordinary Stripe
 * accounts but not the old Express catalog, while Iceland is the reverse.
 * Cross-checked against separate Stripe sources on 2026-10-06:
 *   - Standard/full-dashboard markets: https://stripe.com/global
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
   * false (no Stripe SEPA business-location support); every other enabled
   * EU/EEA country and the United Kingdom is true. See Stripe's published
   * SEPA business-location list and the per-country comments below.
   */
  supportsSepaDebit: boolean
}

export interface RequiredStripeCapabilities {
  card_payments: { requested: true }
  sepa_debit_payments?: { requested: true }
  // Stripe rejects `card_payments` on a legacy Express account unless `transfers`
  // is requested alongside it — a platform-level pairing rule enforced at
  // account-creation time, unrelated to which charge architecture actually
  // moves the money. Direct Charges settle on the connected account itself
  // and never need `transfers` to be ACTIVE (see stripeAccountReadiness.ts,
  // which deliberately excludes it from payoutReady/onboardingComplete) —
  // but it must still be REQUESTED, every time card_payments is, or Stripe
  // refuses to create or update the account at all.
  transfers?: { requested: true }
}

const EU_COUNTRIES: readonly OnboardingCountry[] = [
  { code: 'AT', label: 'Austria', region: 'eu', supportsSepaDebit: true },
  { code: 'BE', label: 'Belgium', region: 'eu', supportsSepaDebit: true },
  { code: 'BG', label: 'Bulgaria', region: 'eu', supportsSepaDebit: true },
  // Standard/full-dashboard is available in Croatia. Legacy Express is not;
  // isStripeAccountTypeAvailable() preserves that distinction.
  { code: 'HR', label: 'Croatia', region: 'eu', supportsSepaDebit: true },
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
  // Standard/full-dashboard is available in Liechtenstein. Legacy Express
  // is not. Iceland has the inverse availability and therefore remains in
  // the combined catalog but is filtered from ordinary Standard onboarding.
  { code: 'LI', label: 'Liechtenstein', region: 'eea', supportsSepaDebit: true },
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
  // Stripe lists GB as a supported SEPA Direct Debit business location.
  // Direct Charges use the connected account's own payment-method settings
  // and Creditor ID, so capability readiness is still checked live before
  // every payment.
  { code: 'GB', label: 'United Kingdom', region: 'stripe_connect', supportsSepaDebit: true },
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

// Standard/full-dashboard markets represented in this catalog. Public
// rollout remains narrower (EU + supported non-EU EEA + UK) unless an
// operator explicitly enables another reviewed code in the server env.
// Iceland and Peru are absent from Stripe's ordinary global-account list.
export const STANDARD_ACCOUNT_COUNTRY_CODES = new Set([
  'AE', 'AT', 'AU', 'BE', 'BG', 'CA', 'CH', 'CI', 'CY', 'CZ', 'DE', 'DK',
  'EE', 'ES', 'FI', 'FR', 'GB', 'GH', 'GR', 'HK', 'HR', 'HU', 'IE', 'IT',
  'JP', 'KE', 'LI', 'LT', 'LU', 'LV', 'MT', 'MX', 'NG', 'NL', 'NO', 'NZ',
  'PL', 'PT', 'RO', 'SE', 'SG', 'SI', 'SK', 'TH', 'US', 'ZA',
])

// Exact historical Express catalog used by the three legacy €3 pilots. HR
// and LI are intentionally absent; IS is intentionally present.
export const EXPRESS_ACCOUNT_COUNTRY_CODES = new Set(`
  AE AG AL AM AR AT AU BA BE BG BH BJ BN BO BS BW CA CH CI CL CO CR CY CZ DE DK
  DO EC EE EG ES ET FI FR GB GH GM GR GT GY HK HU IE IL IS IT JM JO JP KE KH KR
  KW LC LK LT LU LV MA MC MD MG MK MN MO MT MU MX NA NG NL NO NZ OM PA PE PH PK
  PL PT PY QA RO RS RW SA SE SG SI SK SN SV TH TN TR TT TW TZ US UY UZ VN ZA
`.trim().split(/\s+/))

const COUNTRY_BY_CODE = new Map(SUPPORTED_ONBOARDING_COUNTRIES.map((country) => [country.code, country]))

export function getOnboardingCountry(code: string): OnboardingCountry | undefined {
  return COUNTRY_BY_CODE.get(code)
}

export function isSupportedOnboardingCountry(code: string): boolean {
  return COUNTRY_BY_CODE.has(code)
}

export function isStripeAccountTypeAvailable(code: string, accountType: 'standard' | 'express'): boolean {
  const upper = code.toUpperCase()
  return accountType === 'standard'
    ? STANDARD_ACCOUNT_COUNTRY_CODES.has(upper)
    : EXPRESS_ACCOUNT_COUNTRY_CODES.has(upper)
}

export function requiredCapabilitiesForCountry(
  code: string,
  accountType: 'standard' | 'express' = 'standard'
): RequiredStripeCapabilities | null {
  const country = getOnboardingCountry(code)
  if (!country || !isStripeAccountTypeAvailable(code, accountType)) return null

  return {
    card_payments: { requested: true },
    // Stripe requires this pairing for legacy Express creation. Standard
    // accounts used by every new task own their Direct Charges and do not
    // need the platform-transfer capability.
    ...(accountType === 'express' ? { transfers: { requested: true as const } } : {}),
    ...(country.supportsSepaDebit ? { sepa_debit_payments: { requested: true as const } } : {}),
  }
}

export function onboardingCountryGroups(): Array<{ label: string; countries: readonly OnboardingCountry[] }> {
  return [
    { label: 'European Union', countries: EU_COUNTRIES },
    { label: 'EEA (outside the EU)', countries: EEA_COUNTRIES },
    { label: 'Other Stripe Connect countries', countries: OTHER_STRIPE_CONNECT_COUNTRIES },
  ]
}
