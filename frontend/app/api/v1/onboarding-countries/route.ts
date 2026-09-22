import { NextResponse } from 'next/server'
import { getEnabledOnboardingCountryGroups, getEnabledOnboardingCountryCodes, getPaymentEnabledCountryCodes } from '@/lib/server/stripeConnectCountries'

// Public, unauthenticated — the country selector on /agent/stripe-onboard
// needs this before an agent has any session at all. Server-only, because
// the enabled list depends on STRIPE_CONNECT_ENABLED_COUNTRIES (see
// frontend/lib/server/stripeConnectCountries.ts), which a client bundle
// cannot read. This is the single source of truth the UI, the OpenAPI spec,
// and the discovery JSON all draw from — see docs/stripe-connect-country-support.md.
//
// force-dynamic: without it, Next.js statically optimizes this
// parameter-less GET at build time and would keep serving whatever the env
// var happened to be during the build.
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    // "Registration supported" — permitted to START onboarding. Distinct
    // from, and always a superset of, payment_enabled_country_codes below
    // — see getPaymentEnabledCountryCodes's own doc comment for why being
    // on this list alone must never be read as payment support.
    enabled_country_codes: getEnabledOnboardingCountryCodes(),
    groups: getEnabledOnboardingCountryGroups(),
    // "Payments enabled" — a NEW Direct Charge payment can actually be
    // created for a connected account in this country (gated separately
    // by STRIPE_DIRECT_CHARGE_COUNTRIES, defaults to empty). A country
    // only appears here when it is enabled for BOTH onboarding and Direct
    // Charges.
    payment_enabled_country_codes: getPaymentEnabledCountryCodes(),
    note: 'enabled_country_codes are the countries Mercatai currently permits starting Stripe Connect onboarding for — being listed there means onboarding is permitted, not that a payout has been verified end-to-end, and not that a payment can be created yet. payment_enabled_country_codes is the narrower, separately-gated list for which a new Direct Charge payment can actually be created today.',
  }, { headers: { 'Cache-Control': 'no-store' } })
}
