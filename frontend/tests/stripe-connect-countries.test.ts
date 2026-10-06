import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  getEnabledOnboardingCountryCodes,
  getEnabledOnboardingCountries,
  isOnboardingCountryEnabled,
  getEnabledOnboardingCountryGroups,
  getDirectChargeEnabledCountryCodes,
  isDirectChargeCountryEnabled,
  getPaymentEnabledCountryCodes,
  isPaymentCountryEnabled,
} from '@/lib/server/stripeConnectCountries'

// Every test restores the env var afterward — this module reads
// process.env fresh per call (no module-scope caching), by design, so
// other test files sharing this process under vitest's isolate:false must
// never see a value this file happened to leave behind.
const ORIGINAL = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
const ORIGINAL_DIRECT_CHARGE = process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
  else process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = ORIGINAL
  if (ORIGINAL_DIRECT_CHARGE === undefined) delete process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
  else process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = ORIGINAL_DIRECT_CHARGE
})

describe('getEnabledOnboardingCountryCodes', () => {
  const euEeaUk = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','LI','NO','GB']

  it('falls back to the EU/EEA + UK Direct Charges rollout when the env var is unset', () => {
    delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    expect(getEnabledOnboardingCountryCodes()).toEqual(euEeaUk)
  })

  it('falls back to the same default when the env var is empty or whitespace', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = '   '
    expect(getEnabledOnboardingCountryCodes()).toEqual(euEeaUk)
  })

  it('parses a real comma-separated list, trimming and upper-casing each code', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = ' cz, de ,no,au'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE', 'NO', 'AU'])
  })

  it('drops an invalid/unknown code (not in the internal catalog) rather than throwing, and keeps the valid ones', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,XX,DE'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE'])
  })

  it('falls back to the EU/EEA + UK rollout when every supplied code is invalid — never an empty offering', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'XX,YY,ZZ'
    expect(getEnabledOnboardingCountryCodes()).toEqual(euEeaUk)
  })

  it('de-duplicates repeated codes', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,CZ,cz,DE'
    expect(getEnabledOnboardingCountryCodes()).toEqual(['CZ', 'DE'])
  })

  it('rejects a catalog country without Standard/full-dashboard availability (Iceland)', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,IS'
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
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'DE,AU'
    const countries = getEnabledOnboardingCountries()
    expect(countries.map((c) => c.code)).toEqual(['DE', 'AU'])
    expect(countries.find((c) => c.code === 'DE')?.supportsSepaDebit).toBe(true)
    expect(countries.find((c) => c.code === 'AU')?.supportsSepaDebit).toBe(false)
  })

  it('marks the UK and Liechtenstein as SEPA-capable and filters Iceland from Standard onboarding', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'GB,LI,IS'
    const countries = getEnabledOnboardingCountries()
    expect(countries.find((c) => c.code === 'GB')?.supportsSepaDebit).toBe(true)
    expect(countries.find((c) => c.code === 'LI')?.supportsSepaDebit).toBe(true)
    expect(countries.find((c) => c.code === 'IS')).toBeUndefined()
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
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'DE,AU'
    const groups = getEnabledOnboardingCountryGroups()
    const labels = groups.map((g) => g.label)

    expect(labels).toContain('European Union')
    expect(labels).toContain('Other Stripe Connect countries')
    // No enabled EEA-outside-EU country in this set (LI/NO not included) —
    // that whole group must be absent, not present-but-empty.
    expect(labels).not.toContain('EEA (outside the EU)')

    const flatCodes = groups.flatMap((g) => g.countries.map((c) => c.code))
    expect(flatCodes.sort()).toEqual(['AU', 'DE'])
  })
})

describe('getDirectChargeEnabledCountryCodes / isDirectChargeCountryEnabled — fail-closed, separate from onboarding', () => {
  it('resolves to an EMPTY list when the env var is unset — unlike onboarding, never a broad default', () => {
    delete process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
    expect(getDirectChargeEnabledCountryCodes()).toEqual([])
  })

  it('resolves to an empty list when the env var is empty or whitespace', () => {
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = '   '
    expect(getDirectChargeEnabledCountryCodes()).toEqual([])
  })

  for (const code of ['FR', 'ES', 'GB']) {
    it(`allows ${code} to be enabled individually, without enabling any other country`, () => {
      process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = code
      expect(getDirectChargeEnabledCountryCodes()).toEqual([code])
      expect(isDirectChargeCountryEnabled(code)).toBe(true)
      expect(isDirectChargeCountryEnabled(code === 'FR' ? 'ES' : 'FR')).toBe(false)
    })
  }

  it('a country enabled for onboarding but NOT listed here is correctly reported as not Direct-Charge-enabled', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ,DE'
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'DE'
    expect(isDirectChargeCountryEnabled('CZ')).toBe(false)
    expect(isDirectChargeCountryEnabled('DE')).toBe(true)
  })

  it('drops an invalid/unknown code rather than throwing, keeping the valid ones', () => {
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'FR,XX,ES'
    expect(getDirectChargeEnabledCountryCodes()).toEqual(['FR', 'ES'])
  })

  it('when EVERY supplied code is invalid, resolves to EMPTY — never falls back to a broad default the way onboarding does', () => {
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'XX,YY,ZZ'
    expect(getDirectChargeEnabledCountryCodes()).toEqual([])
  })

  it('accepts Croatia in the raw Direct Charge allowlist; Standard onboarding is checked separately', () => {
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'FR,HR'
    expect(getDirectChargeEnabledCountryCodes()).toEqual(['FR', 'HR'])
  })

  it('de-duplicates and is case-insensitive', () => {
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'fr,FR,Fr'
    expect(getDirectChargeEnabledCountryCodes()).toEqual(['FR'])
  })

  it('logs an invalid code without ever including the raw env var value or any secret-shaped content', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'FR,NOTREAL'
      getDirectChargeEnabledCountryCodes()
      const loggedText = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(loggedText).toContain('NOTREAL')
      expect(loggedText).not.toMatch(/sk_(test|live)_|whsec_/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('getPaymentEnabledCountryCodes — publicly "payment supported" requires BOTH onboarding AND Direct Charges', () => {
  it('is empty when Direct Charges are unset, even if onboarding is wide open', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'FR,ES,GB,DE'
    delete process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
    expect(getPaymentEnabledCountryCodes()).toEqual([])
  })

  it('excludes a country enabled for Direct Charges but not (yet) for onboarding', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'FR'
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'FR,ES'
    expect(getPaymentEnabledCountryCodes()).toEqual(['FR'])
  })

  it('is the exact intersection when both lists overlap partially', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'FR,ES,DE'
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'ES,DE,GB'
    expect(getPaymentEnabledCountryCodes().sort()).toEqual(['DE', 'ES'])
  })
})

describe('isPaymentCountryEnabled — the single-code intersection check a real payment gate must use', () => {
  it('is true only when the code is on BOTH lists', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'FR,DE'
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'DE,ES'
    expect(isPaymentCountryEnabled('DE')).toBe(true)
    // Onboarding-enabled but NOT Direct-Charge-enabled.
    expect(isPaymentCountryEnabled('FR')).toBe(false)
    // Direct-Charge-enabled but NOT onboarding-enabled — the exact P0 gap
    // an earlier version of the payment gate had (it checked
    // isDirectChargeCountryEnabled alone).
    expect(isPaymentCountryEnabled('ES')).toBe(false)
  })

  it('is false for every code when either list is empty/unset', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ'
    delete process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
    expect(isPaymentCountryEnabled('CZ')).toBe(false)
  })

  it('is case-insensitive, matching isOnboardingCountryEnabled/isDirectChargeCountryEnabled', () => {
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'DE'
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'DE'
    expect(isPaymentCountryEnabled('de')).toBe(true)
    expect(isPaymentCountryEnabled('De')).toBe(true)
  })
})
