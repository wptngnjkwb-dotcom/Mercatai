import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_ONBOARDING_COUNTRIES,
  SUPPORTED_ONBOARDING_COUNTRY_CODES,
  EXPRESS_ACCOUNT_COUNTRY_CODES,
  STANDARD_ACCOUNT_COUNTRY_CODES,
  getOnboardingCountry,
  isStripeAccountTypeAvailable,
  onboardingCountryGroups,
  requiredCapabilitiesForCountry,
} from '@/lib/onboardingCountries'

// All 27 EU member states are available for Standard/full-dashboard accounts.
const EU_CODES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]

// Exact Stripe Express connected-account availability list published at
// https://docs.stripe.com/connect/accounts (checked 2026-09-10). Keeping the
// complete independent fixture catches omissions in the production catalog;
// checking only EU membership previously missed AG and AR.
const STRIPE_EXPRESS_CODES = `
  AE AG AL AM AR AT AU BA BE BG BH BJ BN BO BS BW CA CH CI CL CO CR CY CZ DE DK
  DO EC EE EG ES ET FI FR GB GH GM GR GT GY HK HU IE IL IS IT JM JO JP KE KH KR
  KW LC LK LT LU LV MA MC MD MG MK MN MO MT MU MX NA NG NL NO NZ OM PA PE PH PK
  PL PT PY QA RO RS RW SA SE SG SI SK SN SV TH TN TR TT TW TZ US UY UZ VN ZA
`.trim().split(/\s+/)

describe('Stripe Connect onboarding countries', () => {
  it('preserves Stripe’s documented Express list and adds the two Standard-only rollout countries', () => {
    expect(Array.from(EXPRESS_ACCOUNT_COUNTRY_CODES).sort()).toEqual([...STRIPE_EXPRESS_CODES].sort())
    expect([...SUPPORTED_ONBOARDING_COUNTRY_CODES].sort()).toEqual([...STRIPE_EXPRESS_CODES, 'HR', 'LI'].sort())
    expect(SUPPORTED_ONBOARDING_COUNTRY_CODES).toHaveLength(105)
  })

  it('contains all 27 EU member states exactly once', () => {
    const configuredEuCodes = SUPPORTED_ONBOARDING_COUNTRIES
      .filter((country) => country.region === 'eu')
      .map((country) => country.code)
      .sort()

    expect(configuredEuCodes).toEqual([...EU_CODES].sort())
    expect(new Set(SUPPORTED_ONBOARDING_COUNTRY_CODES).size).toBe(SUPPORTED_ONBOARDING_COUNTRY_CODES.length)
  })

  it('supports Croatia and Liechtenstein for Standard but never for legacy Express', () => {
    for (const code of ['HR', 'LI']) {
      expect(getOnboardingCountry(code)).toBeDefined()
      expect(isStripeAccountTypeAvailable(code, 'standard')).toBe(true)
      expect(isStripeAccountTypeAvailable(code, 'express')).toBe(false)
      expect(requiredCapabilitiesForCountry(code, 'express')).toBeNull()
    }
  })

  it('keeps account-model availability distinct inside the non-EU EEA group', () => {
    expect(['IS', 'LI', 'NO'].every((code) => getOnboardingCountry(code)?.region === 'eea')).toBe(true)
    expect(isStripeAccountTypeAvailable('IS', 'standard')).toBe(false)
    expect(isStripeAccountTypeAvailable('IS', 'express')).toBe(true)
    expect(isStripeAccountTypeAvailable('LI', 'standard')).toBe(true)
    expect(isStripeAccountTypeAvailable('LI', 'express')).toBe(false)
  })

  it('does not offer a Standard account in Iceland, but preserves card-only Express for a legacy pilot', () => {
    expect(getOnboardingCountry('IS')?.supportsSepaDebit).toBe(false)
    expect(requiredCapabilitiesForCountry('IS', 'standard')).toBeNull()
    expect(requiredCapabilitiesForCountry('IS', 'express')).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    })
  })

  it('requests card and SEPA, but not transfers, for every Standard rollout country except its documented method exceptions', () => {
    for (const country of SUPPORTED_ONBOARDING_COUNTRIES.filter((item) => STANDARD_ACCOUNT_COUNTRY_CODES.has(item.code))) {
      expect(requiredCapabilitiesForCountry(country.code)).toEqual({
        card_payments: { requested: true },
        ...(country.supportsSepaDebit ? { sepa_debit_payments: { requested: true } } : {}),
      })
    }
  })

  it('does not silently create Standard accounts outside the reviewed Standard rollout', () => {
    for (const country of SUPPORTED_ONBOARDING_COUNTRIES.filter((item) => !STANDARD_ACCOUNT_COUNTRY_CODES.has(item.code))) {
      expect(requiredCapabilitiesForCountry(country.code, 'standard')).toBeNull()
    }
  })

  it('pairs transfers with card_payments only where the server-selected Express model is available', () => {
    for (const country of SUPPORTED_ONBOARDING_COUNTRIES) {
      if (EXPRESS_ACCOUNT_COUNTRY_CODES.has(country.code)) {
        expect(requiredCapabilitiesForCountry(country.code, 'express')).toMatchObject({ transfers: { requested: true } })
      } else {
        expect(requiredCapabilitiesForCountry(country.code, 'express')).toBeNull()
      }
      const standard = requiredCapabilitiesForCountry(country.code, 'standard')
      if (standard) expect(standard).not.toHaveProperty('transfers')
    }
  })

  it('includes Peru and Taiwan as independent country entries', () => {
    expect(getOnboardingCountry('PE')?.label).toBe('Peru')
    expect(getOnboardingCountry('TW')?.label).toBe('Taiwan')
  })

  it('returns no capability profile for an unsupported or malformed country', () => {
    expect(requiredCapabilitiesForCountry('XX')).toBeNull()
    expect(requiredCapabilitiesForCountry('')).toBeNull()
  })

  it('exposes UI groups without dropping or duplicating countries', () => {
    const groupedCodes = onboardingCountryGroups().flatMap((group) => group.countries.map((country) => country.code))
    expect(groupedCodes).toEqual(SUPPORTED_ONBOARDING_COUNTRY_CODES)
  })
})
