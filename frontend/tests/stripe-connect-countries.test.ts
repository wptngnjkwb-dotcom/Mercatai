import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  getEnabledOnboardingCountryCodes,
  getEnabledOnboardingCountries,
  isOnboardingCountryEnabled,
  getEnabledOnboardingCountryGroups,
} from '@/lib/server/stripeConnectCountries'

// Every test restores the env var afterward — this module reads
// process.env fresh per call (no module-scope caching), by design, so
// other test files sharing this process under vitest's isolate:false must
// never see a value this file happened to leave behind.
const ORIGINAL = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
  else process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = ORIGINAL
})

describe('getEnabledOnboardingCountryCodes', () => {
  it('falls back to the conservative CZ,DE,NO default when the env var is unset', () => {
    delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE', 'NO'])
  })

  it('falls back to the same default when the env var is empty or whitespace', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = '   '
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE', 'NO'])
  })

  it('parses a real comma-separated list, trimming and upper-casing each code', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = ' cz, de ,no,pe'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE', 'NO', 'PE'])
  })

  it('drops an invalid/unknown code (not in the internal catalog) rather than throwing, and keeps the valid ones', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,XX,DE'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE'])
  })

  it('falls back to the conservative default when every supplied code is invalid — never an empty offering', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'XX,YY,ZZ'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE', 'NO'])
  })

  it('de-duplicates repeated codes', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,CZ,cz,DE'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE'])
  })

  it('rejects a country that is a real ISO code but outside Mercatai\'s Stripe Express catalog (e.g. Croatia — see onboardingCountries.ts)', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,HR'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ'])
  })

  it('clearly logs an invalid code without ever including the raw env var value or any secret-shaped content', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,NOTREAL'
      getEnabledOnboardingCountryCodes()

      expect(errorSpy).toHaveBeenCalled()
      const loggedText = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(loggedText).toContain('NOTREAL')
      expect(loggedText).not.toMatch(/sk_(test|live)_|whsec_/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('getEnabledOnboardingCountries / isOnboardingCountryEnabled', () => {
  it('resolves full country objects only for the enabled codes', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'DE,PE'
    const countries = getEnabledOnboardingCountries()
    expect(countries.map((c) => c.code)).toEqual(['DE', 'PE'])
    expect(countries.find((c) => c.code === 'DE')?.supportsSepaDebit).toBe(true)
    expect(countries.find((c) => c.code === 'PE')?.supportsSepaDebit).toBe(false)
  })

  it('isOnboardingCountryEnabled reflects the same allowlist, case-insensitively', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,DE'
    expect(isOnboardingCountryEnabled('CZ')).toBe(true)
    expect(isOnboardingCountryEnabled('cz')).toBe(true)
    expect(isOnboardingCountryEnabled('NO')).toBe(false)
  })
})

describe('getEnabledOnboardingCountryGroups', () => {
  it('filters the standard EU/EEA/other grouping down to only enabled countries, dropping empty groups', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'DE,PE'
    const groups = getEnabledOnboardingCountryGroups()
    const labels = groups.map((g) => g.label)

    expect(labels).toContain('European Union')
    expect(labels).toContain('Other Stripe Connect countries')
    // No enabled EEA-outside-EU country in this set (NO/IS not included) —
    // that whole group must be absent, not present-but-empty.
    expect(labels).not.toContain('EEA (outside the EU)')

    const flatCodes = groups.flatMap((g) => g.countries.map((c) => c.code))
    expect(flatCodes.sort()).toEqual(['DE', 'PE'])
  })
})
