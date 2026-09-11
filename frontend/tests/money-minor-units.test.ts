import { describe, expect, it } from 'vitest'
import { formatMinorAmount, minorUnitExponent } from '@/lib/server/stripeConnectMonitoring'

describe('minorUnitExponent / formatMinorAmount — exact minor-unit amounts, currency-aware formatting', () => {
  it('uses 2 decimal places for EUR/CZK/NOK — the currencies this platform actually uses today', () => {
    expect(minorUnitExponent('eur')).toBe(2)
    expect(minorUnitExponent('czk')).toBe(2)
    expect(minorUnitExponent('nok')).toBe(2)
    expect(formatMinorAmount(12345, 'eur')).toBe('123.45 EUR')
  })

  it('uses 0 decimal places for a zero-decimal currency (JPY) — dividing by 100 would be wrong', () => {
    expect(minorUnitExponent('jpy')).toBe(0)
    expect(formatMinorAmount(500, 'jpy')).toBe('500 JPY')
  })

  it('is case-insensitive on the currency code', () => {
    expect(minorUnitExponent('JPY')).toBe(0)
    expect(formatMinorAmount(500, 'JPY')).toBe('500 JPY')
  })

  it('never loses precision to floating-point division — an exact integer amount_minor round-trips exactly', () => {
    // 12345 minor units of EUR is exactly 123.45, not 123.44999999999999.
    expect(formatMinorAmount(12345, 'eur')).toBe('123.45 EUR')
    expect(formatMinorAmount(1, 'eur')).toBe('0.01 EUR')
    expect(formatMinorAmount(100000000, 'eur')).toBe('1000000.00 EUR')
  })
})
