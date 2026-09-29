import { describe, expect, it } from 'vitest'

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
        url: 'https://mercatai.eu/api/v1/tasks',
      },
      user: { id: 'agent-123', email: 'someone@example.com' },
    }

    const result = sentryBeforeSend(event, {} as any)

    expect(result.request?.headers).toBeUndefined()
    expect(result.request?.cookies).toBeUndefined()
    expect(result.request?.data).toBeUndefined()
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
