import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sendPayoutFailedAdminAlertOrThrow, buildAdminAlertProviderPayload, ADMIN_ALERT_PAYLOAD_VERSION } from '@/lib/server/email'

// Deliberately does NOT mock @/lib/server/supabase or 'stripe' — this file
// tests both functions in isolation, exercising the REAL implementations
// (only 'resend' is mocked), because the requirement under test is
// specifically that these throw rather than silently logging "skipping"
// the way the general-purpose `send()` helper does for other templates.

type ResendSendResult = { data: { id: string } | null; error: { name: string; message: string; statusCode: number } | null }
const resendSend = vi.fn<(payload: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<ResendSendResult>>(async () => ({ data: { id: 'email-1' }, error: null }))
vi.mock('resend', () => ({
  Resend: vi.fn(function () {
    return { emails: { send: resendSend } }
  }),
}))

const buildParams = {
  payoutId: 'po_1',
  stripeAccountId: 'acct_1',
  agentId: 'agent-1',
  amountLabel: '100.00 EUR',
  failureCode: 'account_closed',
}
const idempotencyKey = 'payout-failed-alert:acct_1:po_1'

let originalAdminAlertEmail: string | undefined
let originalResendApiKey: string | undefined

beforeEach(() => {
  originalAdminAlertEmail = process.env.ADMIN_ALERT_EMAIL
  originalResendApiKey = process.env.RESEND_API_KEY
  resendSend.mockClear()
})

afterEach(() => {
  if (originalAdminAlertEmail === undefined) delete process.env.ADMIN_ALERT_EMAIL
  else process.env.ADMIN_ALERT_EMAIL = originalAdminAlertEmail
  if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = originalResendApiKey
})

describe('buildAdminAlertProviderPayload — the only place ADMIN_ALERT_EMAIL / the template is read', () => {
  it('throws when ADMIN_ALERT_EMAIL is not configured, rather than silently building an unsendable payload', () => {
    delete process.env.ADMIN_ALERT_EMAIL
    expect(() => buildAdminAlertProviderPayload(buildParams)).toThrow(/ADMIN_ALERT_EMAIL/)
  })

  it('never touches RESEND_API_KEY or checks it — that belongs to sendPayoutFailedAdminAlertOrThrow', () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    delete process.env.RESEND_API_KEY
    expect(() => buildAdminAlertProviderPayload(buildParams)).not.toThrow()
  })

  it('builds a payload with the current ADMIN_ALERT_EMAIL as `to`, and stamps the current payload version', () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    const payload = buildAdminAlertProviderPayload(buildParams)
    expect(payload.to).toBe('admin@example.com')
    expect(payload.payloadVersion).toBe(ADMIN_ALERT_PAYLOAD_VERSION)
    expect(payload.html).toContain('po_1')
    expect(payload.html).toContain('100.00 EUR')
  })

  it('never includes the Resend API key, a bank account number, or other PII in the built payload', () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'sk-should-never-appear'
    const payload = buildAdminAlertProviderPayload(buildParams)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('sk-should-never-appear')
    expect(serialized).not.toMatch(/iban|account_holder|routing_number/i)
  })
})

describe('sendPayoutFailedAdminAlertOrThrow — a critical alert must never silently succeed', () => {
  it('throws when RESEND_API_KEY is not configured, rather than logging "skipping"', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    delete process.env.RESEND_API_KEY
    const payload = buildAdminAlertProviderPayload(buildParams)
    await expect(sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)).rejects.toThrow(/RESEND_API_KEY/)
    expect(resendSend).not.toHaveBeenCalled()
  })

  it('propagates a real Resend request-level failure rather than swallowing it', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const payload = buildAdminAlertProviderPayload(buildParams)
    resendSend.mockRejectedValueOnce(new Error('Resend API unavailable'))
    await expect(sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)).rejects.toThrow(/Resend API unavailable/)
  })

  it('propagates a Resend { error } response (which the SDK does not throw on) rather than treating it as success', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const payload = buildAdminAlertProviderPayload(buildParams)
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', message: 'invalid recipient', statusCode: 422 } })
    await expect(sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)).rejects.toThrow(/invalid recipient/)
  })

  it('never masks invalid_idempotent_request as success — a reused key with a changed payload is a real error, not retryable-as-is', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const payload = buildAdminAlertProviderPayload(buildParams)
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'invalid_idempotent_request', message: 'payload mismatch', statusCode: 409 } })
    await expect(sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)).rejects.toThrow(/invalid_idempotent_request/)
  })

  it('treats concurrent_idempotent_requests as a retryable failure, never as success', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const payload = buildAdminAlertProviderPayload(buildParams)
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'concurrent_idempotent_requests', message: 'still processing', statusCode: 409 } })
    await expect(sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)).rejects.toThrow(/concurrent_idempotent_requests/)
  })

  it('succeeds and returns the email id Resend assigned, passing the idempotency key as the second SDK argument, and never sends payloadVersion to Resend', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const payload = buildAdminAlertProviderPayload(buildParams)
    const result = await sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)
    expect(result).toBe('email-1')
    expect(resendSend).toHaveBeenCalledWith(
      { from: payload.from, to: 'admin@example.com', subject: payload.subject, html: payload.html },
      { idempotencyKey }
    )
  })

  it('throws when Resend resolves without an error but also without an email id', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const payload = buildAdminAlertProviderPayload(buildParams)
    resendSend.mockResolvedValueOnce({ data: null, error: null })
    await expect(sendPayoutFailedAdminAlertOrThrow(payload, idempotencyKey)).rejects.toThrow(/no email id/)
  })

  it('sends whatever payload it is given, even if ADMIN_ALERT_EMAIL has since changed — it never re-reads env vars itself', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const frozenPayload = buildAdminAlertProviderPayload(buildParams)

    process.env.ADMIN_ALERT_EMAIL = 'someone-else@example.com'
    await sendPayoutFailedAdminAlertOrThrow(frozenPayload, idempotencyKey)

    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@example.com' }), // the FROZEN address, not the changed one
      { idempotencyKey }
    )
  })
})
