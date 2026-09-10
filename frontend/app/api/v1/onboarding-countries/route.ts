import { NextResponse } from 'next/server'
import { getEnabledOnboardingCountryGroups, getEnabledOnboardingCountryCodes } from '@/lib/server/stripeConnectCountries'

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
    enabled_country_codes: getEnabledOnboardingCountryCodes(),
    groups: getEnabledOnboardingCountryGroups(),
    note: 'These are the countries Mercatai currently permits starting Stripe Connect onboarding for. Being listed here means onboarding is permitted, not that a payout has been verified end-to-end for that country — Stripe performs live capability and identity checks during and after onboarding regardless.',
  }, { headers: { 'Cache-Control': 'no-store' } })
}
