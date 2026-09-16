// Currencies Stripe treats as having no fractional/minor unit — the
// integer amount Stripe reports IS the whole-currency amount already, not
// a smallest-unit count to divide by 100. All other currencies (including
// today's CZK/EUR/NOK) use 2 decimal places. This is deliberately not the
// data model: an amount_minor column always stores Stripe's raw integer
// unchanged — this function only matters when FORMATTING an amount for a
// human (UI, email), never when persisting one.
// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? 0 : 2
}

export function formatMinorAmount(amountMinor: number, currency: string): string {
  const exponent = minorUnitExponent(currency)
  const amount = amountMinor / 10 ** exponent
  return `${amount.toFixed(exponent)} ${currency.toUpperCase()}`
}
