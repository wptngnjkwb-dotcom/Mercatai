import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_ONBOARDING_COUNTRIES,
  SUPPORTED_ONBOARDING_COUNTRY_CODES,
  getOnboardingCountry,
  onboardingCountryGroups,
  requiredCapabilitiesForCountry,
} from '@/lib/onboardingCountries'

// 26 of the 27 EU member states — Croatia is excluded, see the dedicated
// test below for why.
const EU_CODES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]

describe('Stripe Connect onboarding countries', () => {
  it('contains 26 of the 27 EU member states exactly once', () => {
    const configuredEuCodes = SUPPORTED_ONBOARDING_COUNTRIES
      .filter((country) => country.region === 'eu')
      .map((country) => country.code)
      .sort()

    expect(configuredEuCodes).toEqual([...EU_CODES].sort())
    expect(new Set(SUPPORTED_ONBOARDING_COUNTRY_CODES).size).toBe(SUPPORTED_ONBOARDING_COUNTRY_CODES.length)
  })

  it('excludes Croatia and Liechtenstein — EU/EEA members with no Stripe Express connected-account availability', () => {
    // Verified directly against https://docs.stripe.com/connect/accounts on
    // 2026-09-09: neither code appears in Stripe's documented Express
    // country list, so stripe.accounts.create({ type: 'express', country:
    // 'HR' | 'LI', ... }) fails at Stripe's API. Do not re-add either
    // without re-checking that page first.
    expect(getOnboardingCountry('HR')).toBeUndefined()
    expect(getOnboardingCountry('LI')).toBeUndefined()
    expect(SUPPORTED_ONBOARDING_COUNTRY_CODES).not.toContain('HR')
    expect(SUPPORTED_ONBOARDING_COUNTRY_CODES).not.toContain('LI')
  })

  it('also contains the two remaining non-EU EEA countries with Express availability', () => {
    expect(['IS', 'NO'].every((code) => getOnboardingCountry(code)?.region === 'eea')).toBe(true)
  })

  it('requests only card and transfers for Iceland, unlike every other EU/EEA country', () => {
    // Iceland has Express connected-account availability but is absent from
    // Stripe's SEPA Direct Debit business-location list (checked
    // 2026-09-09) — requesting sepa_debit_payments for an 'IS' account
    // would request a capability Stripe won't grant.
    expect(getOnboardingCountry('IS')?.supportsSepaDebit).toBe(false)
    expect(requiredCapabilitiesForCountry('IS')).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    })
  })

  it('requests card, SEPA Direct Debit, and transfers for every other EU/EEA country', () => {
    for (const country of SUPPORTED_ONBOARDING_COUNTRIES.filter((item) => item.region !== 'stripe_connect' && item.code !== 'IS')) {
      expect(requiredCapabilitiesForCountry(country.code)).toEqual({
        card_payments: { requested: true },
        sepa_debit_payments: { requested: true },
        transfers: { requested: true },
      })
    }
  })

  it('requests only card and transfers for other Stripe Connect countries', () => {
    for (const country of SUPPORTED_ONBOARDING_COUNTRIES.filter((item) => item.region === 'stripe_connect')) {
      expect(requiredCapabilitiesForCountry(country.code)).toEqual({
        card_payments: { requested: true },
        transfers: { requested: true },
      })
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
