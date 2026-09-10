import { describe, expect, it } from 'vitest'
import { GET as getDiscoveryJson } from '@/app/api/discovery/agent-json/route'
import { GET as getOnboardingCountries } from '@/app/api/v1/onboarding-countries/route'
import { GET as getOpenApiSpec } from '@/app/api/v1/openapi/route'

// None of these three routes touch Supabase, Stripe, or auth — they only
// read STRIPE_CONNECT_ENABLED_COUNTRIES (frontend/lib/server/stripeConnectCountries.ts)
// fresh per request, so no vi.mock is needed and there is nothing here that
// could collide with another file's mocks under vitest's isolate:false.
async function withEnabledCountries<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
  process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = value
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    else process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = original
  }
}

describe('Public UI / OpenAPI / discovery JSON share one Stripe Connect country allowlist', () => {
  it('the onboarding-countries endpoint, discovery JSON, and OpenAPI spec all list exactly the same codes', async () => {
    await withEnabledCountries('CZ,DE,NO,PE', async () => {
      const onboardingCountries = await (await getOnboardingCountries()).json()
      const discovery = await (await getDiscoveryJson()).json()
      const spec = await (await getOpenApiSpec()).json()
      const openApiCodes = spec.paths['/api/v1/agents/{id}/stripe-onboard']
        .post.requestBody.content['application/json'].schema.properties.country.enum

      expect(onboardingCountries.enabled_country_codes).toEqual(['CZ', 'DE', 'NO', 'PE'])
      expect(discovery.stripe_connect_onboarding_countries).toEqual(['CZ', 'DE', 'NO', 'PE'])
      expect(openApiCodes).toEqual(['CZ', 'DE', 'NO', 'PE'])
    })
  })

  it('the onboarding-countries endpoint groups every enabled country exactly once, matching its own flat code list', async () => {
    await withEnabledCountries('CZ,DE,NO,PE,TW', async () => {
      const body = await (await getOnboardingCountries()).json()
      const groupedCodes = body.groups.flatMap((g: { countries: { code: string }[] }) => g.countries.map((c) => c.code))
      expect(groupedCodes.sort()).toEqual([...body.enabled_country_codes].sort())
    })
  })

  it('discovery JSON text distinguishes "onboarding permitted" from "payout verified end-to-end"', async () => {
    const discovery = await (await getDiscoveryJson()).json()
    expect(discovery.stripe_connect_onboarding_countries_note).toMatch(/permit/i)
    expect(discovery.stripe_connect_onboarding_countries_note).toMatch(/not that a payout has been verified end-to-end/i)
  })

  it('the onboarding-countries endpoint carries the same permitted-vs-verified distinction', async () => {
    const body = await (await getOnboardingCountries()).json()
    expect(body.note).toMatch(/onboarding is permitted, not that a payout has been verified end-to-end/i)
  })

  it('never falls back to the full ~103-country catalog when nothing is configured — all three surfaces show the conservative default', async () => {
    const original = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    try {
      const onboardingCountries = await (await getOnboardingCountries()).json()
      const discovery = await (await getDiscoveryJson()).json()
      const spec = await (await getOpenApiSpec()).json()
      const openApiCodes = spec.paths['/api/v1/agents/{id}/stripe-onboard']
        .post.requestBody.content['application/json'].schema.properties.country.enum

      expect(onboardingCountries.enabled_country_codes).toEqual(['CZ', 'DE', 'NO'])
      expect(discovery.stripe_connect_onboarding_countries).toEqual(['CZ', 'DE', 'NO'])
      expect(openApiCodes).toEqual(['CZ', 'DE', 'NO'])
    } finally {
      if (original === undefined) delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
      else process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = original
    }
  })
})
