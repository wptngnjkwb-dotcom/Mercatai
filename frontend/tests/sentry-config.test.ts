import { describe, expect, it, vi } from 'vitest'

describe('Sentry stays fully inert without a DSN', () => {
  it('never calls Sentry.init() when NEXT_PUBLIC_SENTRY_DSN is unset, so no instrumentation installs and no request can go out', async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    const Sentry = await import('@sentry/nextjs')
    await import('../sentry.server.config')
    expect(Sentry.isInitialized()).toBe(false)
  })
})

describe('sentryBeforeSend strips headers, cookies, bodies, and stack-frame locals', () => {
  it('removes every sensitive field while preserving the error itself', async () => {
    const { sentryBeforeSend } = await import('../lib/sentryConfig')

    const event: any = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: 'a.ts',
                  function: 'f',
                  vars: { password: 'secret', taskDescription: 'confidential buyer brief' },
                },
              ],
            },
          },
        ],
      },
      request: {
        headers: { authorization: 'Bearer eyJ.some.jwt' },
        cookies: { session: 'abc123' },
        data: { message: 'buyer wrote something sensitive' },
        query_string: 'buyer_token=eyJ.some.buyer.token',
        url: 'https://mercatai.eu/api/v1/tasks?buyer_token=eyJ.some.buyer.token',
      },
      user: { id: 'agent-123', email: 'someone@example.com' },
    }

    const result = sentryBeforeSend(event, {} as any)

    expect(result.request?.headers).toBeUndefined()
    expect(result.request?.cookies).toBeUndefined()
    expect(result.request?.data).toBeUndefined()
    expect(result.request?.query_string).toBeUndefined()
    expect(result.user).toBeUndefined()
    expect(result.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined()

    // The event stays useful for debugging — only the sensitive fields go.
    expect(result.request?.url).toBe('https://mercatai.eu/api/v1/tasks')
    expect(result.exception?.values?.[0]?.value).toBe('boom')
    expect(result.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('a.ts')
  })

  it('is a no-op on an event with no request, user, or stack frames', async () => {
    const { sentryBeforeSend } = await import('../lib/sentryConfig')
    const event: any = { exception: { values: [{ type: 'Error', value: 'boom' }] } }
    const result = sentryBeforeSend(event, {} as any)
    expect(result.exception?.values?.[0]?.value).toBe('boom')
  })
})

describe('SENTRY_TRACES_SAMPLE_RATE parses safely', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE

  async function rateWith(value: string | undefined) {
    vi.resetModules()
    if (value === undefined) delete process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    else process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = value
    const mod = await import('../lib/sentryConfig')
    return mod.SENTRY_TRACES_SAMPLE_RATE
  }

  it('defaults to 0 when unset', async () => {
    expect(await rateWith(undefined)).toBe(0)
  })

  it('accepts a valid value within 0-1', async () => {
    expect(await rateWith('0.25')).toBe(0.25)
    expect(await rateWith('0')).toBe(0)
    expect(await rateWith('1')).toBe(1)
  })

  it('falls back to 0 for a non-numeric value', async () => {
    expect(await rateWith('not-a-number')).toBe(0)
  })

  it('falls back to 0 for a value outside 0-1', async () => {
    expect(await rateWith('5')).toBe(0)
    expect(await rateWith('-1')).toBe(0)
    expect(await rateWith('NaN')).toBe(0)
  })

  it('restores the real env var afterwards', async () => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    else process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = ORIGINAL
    vi.resetModules()
  })
})
