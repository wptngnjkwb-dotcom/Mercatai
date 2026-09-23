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

async function withDirectChargeCountries<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
  if (value === undefined) delete process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
  else process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = value
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.STRIPE_DIRECT_CHARGE_COUNTRIES
    else process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = original
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

  it('falls back to the EU/EEA + UK rollout, not the full global catalog, on all three surfaces', async () => {
    const original = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    try {
      const onboardingCountries = await (await getOnboardingCountries()).json()
      const discovery = await (await getDiscoveryJson()).json()
      const spec = await (await getOpenApiSpec()).json()
      const openApiCodes = spec.paths['/api/v1/agents/{id}/stripe-onboard']
        .post.requestBody.content['application/json'].schema.properties.country.enum

      const expected = ['AT','BE','BG','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','NO','GB']
      expect(onboardingCountries.enabled_country_codes).toEqual(expected)
      expect(discovery.stripe_connect_onboarding_countries).toEqual(expected)
      expect(openApiCodes).toEqual(expected)
    } finally {
      if (original === undefined) delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
      else process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = original
    }
  })
})

describe('Registration-supported vs. payments-enabled — the two lists must never be conflated across surfaces', () => {
  it('onboarding-countries and discovery JSON report the exact same payment_enabled list, and it is unset (empty) by default', async () => {
    await withEnabledCountries('FR,ES,GB,DE', async () => {
      await withDirectChargeCountries(undefined, async () => {
        const onboardingCountries = await (await getOnboardingCountries()).json()
        const discovery = await (await getDiscoveryJson()).json()

        expect(onboardingCountries.payment_enabled_country_codes).toEqual([])
        expect(discovery.stripe_connect_payment_enabled_countries).toEqual([])
      })
    })
  })

  it('onboarding-countries and discovery JSON agree on the payment-enabled list, and it is always a subset of the onboarding-enabled list', async () => {
    await withEnabledCountries('FR,ES,DE', async () => {
      await withDirectChargeCountries('ES,DE,GB', async () => {
        const onboardingCountries = await (await getOnboardingCountries()).json()
        const discovery = await (await getDiscoveryJson()).json()

        expect(onboardingCountries.payment_enabled_country_codes.sort()).toEqual(['DE', 'ES'])
        expect(discovery.stripe_connect_payment_enabled_countries.sort()).toEqual(['DE', 'ES'])
        // GB is Direct-Charge-enabled but NOT onboarding-enabled in this
        // scenario — must never leak into either payment-enabled list.
        expect(onboardingCountries.payment_enabled_country_codes).not.toContain('GB')
        expect(discovery.stripe_connect_payment_enabled_countries).not.toContain('GB')
        for (const code of onboardingCountries.payment_enabled_country_codes) {
          expect(onboardingCountries.enabled_country_codes).toContain(code)
        }
      })
    })
  })

  it('both surfaces carry text distinguishing registration support from payment support', async () => {
    const onboardingCountries = await (await getOnboardingCountries()).json()
    const discovery = await (await getDiscoveryJson()).json()

    expect(onboardingCountries.note).toMatch(/not that a payment can be created/i)
    expect(discovery.stripe_connect_payment_enabled_countries_note).toMatch(/registration support is never itself a promise of payment support/i)
  })

  it('the OpenAPI spec actually documents payment_enabled_country_codes and the country gate\'s 403 — a prior version tested only the onboarding list and left this unverified', async () => {
    const spec = await (await getOpenApiSpec()).json()
    const onboardingCountriesPath = spec.paths['/api/v1/onboarding-countries'].get
    const createIntent403 = spec.paths['/api/v1/payments/create-intent'].post.responses['403'].description

    expect(onboardingCountriesPath.description).toContain('payment_enabled_country_codes')
    expect(onboardingCountriesPath.responses['200'].description).toContain('payment_enabled_country_codes')
    expect(createIntent403).toMatch(/direct_charge_country_enabled/i)
    expect(createIntent403).toMatch(/country/i)
  })

  it('the OpenAPI spec gives /api/v1/onboarding-countries a real, machine-readable response schema — not just a text description an agent client would have to parse by hand', async () => {
    const spec = await (await getOpenApiSpec()).json()
    const schema = spec.paths['/api/v1/onboarding-countries'].get.responses['200'].content['application/json'].schema

    expect(schema.type).toBe('object')
    expect(schema.properties.enabled_country_codes).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(schema.properties.payment_enabled_country_codes).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(schema.properties.groups.type).toBe('array')
    const countryItemProps = schema.properties.groups.items.properties.countries.items.properties
    expect(countryItemProps).toMatchObject({
      code: { type: 'string' },
      label: { type: 'string' },
      supportsSepaDebit: { type: 'boolean' },
    })
  })

  it('the OpenAPI schema\'s field names actually match the real live response — the schema is not just plausible-looking, disconnected prose', async () => {
    const spec = await (await getOpenApiSpec()).json()
    const schema = spec.paths['/api/v1/onboarding-countries'].get.responses['200'].content['application/json'].schema
    const liveResponse = await (await getOnboardingCountries()).json()

    for (const key of Object.keys(schema.properties)) {
      expect(liveResponse).toHaveProperty(key)
    }
  })
})
