import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/v1/openapi/route'
import { mapEscrowStatusToFundingStatus } from '@/lib/server/publicTaskFields'

// Self-contained on purpose: STRIPE_CONNECT_ENABLED_COUNTRIES is read fresh
// per-request (see frontend/lib/server/stripeConnectCountries.ts) and other
// test files set their own value at module scope under vitest's
// isolate:false — this suite must not assume what that currently is, and
// must restore it afterward so it doesn't leak into whichever file runs next.
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

describe('OpenAPI spec — Task.is_demo / Task.funding_status / GET /api/v1/activity', () => {
  it('documents is_demo (boolean) and funding_status on the Task schema', async () => {
    const spec = await (await GET()).json()
    const props = spec.components.schemas.Task.properties
    expect(props).toHaveProperty('is_demo')
    expect(props.is_demo.type).toBe('boolean')
    expect(props).toHaveProperty('funding_status')
  })

  it('the documented funding_status enum matches exactly what mapEscrowStatusToFundingStatus can actually produce — catches drift if a mapping is ever added or removed', async () => {
    const spec = await (await GET()).json()
    const documented = new Set(spec.components.schemas.Task.properties.funding_status.enum)
    const actual = new Set(
      ['pending', 'held', 'released', 'refunded', 'failed', 'disputed', null, 'unknown-future-value'].map((s) =>
        mapEscrowStatusToFundingStatus(s as any)
      )
    )
    expect(documented).toEqual(actual)
  })

  it('documents GET /api/v1/activity, including stats.tasks_completed, stats.gmv_eur, and stats.metrics_scope', async () => {
    const spec = await (await GET()).json()
    const activityPath = spec.paths['/api/v1/activity']
    expect(activityPath?.get).toBeDefined()
    const statsProps = activityPath.get.responses['200'].content['application/json'].schema.properties.stats.properties
    expect(statsProps).toHaveProperty('tasks_completed')
    expect(statsProps).toHaveProperty('gmv_eur')
    expect(statsProps).toHaveProperty('metrics_scope')
  })
})

describe('OpenAPI spec — Stripe Connect countries', () => {
  it('derives the onboarding country enum from the live STRIPE_CONNECT_ENABLED_COUNTRIES allowlist, not the full catalog', async () => {
    await withEnabledCountries('CZ,DE,NO,PE,TW', async () => {
      const spec = await (await GET()).json()
      const country = spec.paths['/api/v1/agents/{id}/stripe-onboard']
        .post.requestBody.content['application/json'].schema.properties.country

      expect(country.enum).toEqual(['CZ', 'DE', 'NO', 'PE', 'TW'])
    })
  })

  it('never includes a country outside the currently-enabled allowlist, even though the full catalog has ~103', async () => {
    await withEnabledCountries('CZ,DE,NO', async () => {
      const spec = await (await GET()).json()
      const country = spec.paths['/api/v1/agents/{id}/stripe-onboard']
        .post.requestBody.content['application/json'].schema.properties.country

      expect(country.enum).toEqual(['CZ', 'DE', 'NO'])
      expect(country.enum).not.toContain('PE')
      expect(country.enum).not.toContain('TW')
    })
  })

  it('falls back to the conservative CZ,DE,NO default when the env var is unset', async () => {
    const original = process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
    try {
      const spec = await (await GET()).json()
      const country = spec.paths['/api/v1/agents/{id}/stripe-onboard']
        .post.requestBody.content['application/json'].schema.properties.country
      expect(country.enum).toEqual(['CZ', 'DE', 'NO'])
    } finally {
      if (original === undefined) delete process.env.STRIPE_CONNECT_ENABLED_COUNTRIES
      else process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = original
    }
  })
})

describe('OpenAPI spec — payment fee field naming (payment_processing_deduction_eur)', () => {
  it('documents the canonical payment_processing_deduction_eur field on PaymentIntentResponse', async () => {
    const spec = await (await GET()).json()
    const props = spec.components.schemas.PaymentIntentResponse.properties
    expect(props).toHaveProperty('payment_processing_deduction_eur')
    expect(props.payment_processing_deduction_eur.type).toBe('number')
  })

  it('marks the legacy stripe_fee_eur field as deprecated rather than silently dropping it', async () => {
    const spec = await (await GET()).json()
    const props = spec.components.schemas.PaymentIntentResponse.properties
    expect(props).toHaveProperty('stripe_fee_eur')
    expect(props.stripe_fee_eur.deprecated).toBe(true)
  })

  it('documents POST /api/v1/payments/create-intent returning PaymentIntentResponse', async () => {
    const spec = await (await GET()).json()
    const path = spec.paths['/api/v1/payments/create-intent']
    expect(path?.post).toBeDefined()
    expect(path.post.responses['201'].content['application/json'].schema['$ref']).toBe(
      '#/components/schemas/PaymentIntentResponse'
    )
  })

  it("documents that the €10,000 transaction cap is Mercatai's own limit, not a KYC threshold", async () => {
    const spec = await (await GET()).json()
    const desc: string = spec.components.schemas.CreateTaskRequest.properties.budget_max_eur.description
    expect(desc).toMatch(/not a KYC/i)
  })
})
