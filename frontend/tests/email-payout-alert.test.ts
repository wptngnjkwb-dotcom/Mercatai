import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sendPayoutFailedAdminAlertOrThrow } from '@/lib/server/email'

// Deliberately does NOT mock @/lib/server/supabase or 'stripe' — this file
// tests sendPayoutFailedAdminAlertOrThrow in isolation, exercising the
// REAL function (only its 'resend' dependency is mocked), because the
// requirement under test is specifically that THIS function throws rather
// than silently logging "skipping" the way the general-purpose `send()`
// helper in the same module does for every other, non-critical template.

type ResendSendResult = { data: { id: string } | null; error: { name: string; message: string; statusCode: number } | null }
const resendSend = vi.fn<(payload: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<ResendSendResult>>(async () => ({ data: { id: 'email-1' }, error: null }))
vi.mock('resend', () => ({
  Resend: vi.fn(function () {
    return { emails: { send: resendSend } }
  }),
}))

const baseParams = {
  payoutId: 'po_1',
  stripeAccountId: 'acct_1',
  agentId: 'agent-1',
  amountLabel: '100.00 EUR',
  failureCode: 'account_closed',
  idempotencyKey: 'payout-failed-alert:acct_1:po_1',
}

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

describe('sendPayoutFailedAdminAlertOrThrow — a critical alert must never silently succeed', () => {
  it('throws when ADMIN_ALERT_EMAIL is not configured, rather than logging "skipping"', async () => {
    delete process.env.ADMIN_ALERT_EMAIL
    process.env.RESEND_API_KEY = 'test-key'
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/ADMIN_ALERT_EMAIL/)
    expect(resendSend).not.toHaveBeenCalled()
  })

  it('throws when RESEND_API_KEY is not configured, rather than logging "skipping"', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    delete process.env.RESEND_API_KEY
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/RESEND_API_KEY/)
    expect(resendSend).not.toHaveBeenCalled()
  })

  it('propagates a real Resend request-level failure rather than swallowing it', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    resendSend.mockRejectedValueOnce(new Error('Resend API unavailable'))
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/Resend API unavailable/)
  })

  it('propagates a Resend { error } response (which the SDK does not throw on) rather than treating it as success', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', message: 'invalid recipient', statusCode: 422 } })
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/invalid recipient/)
  })

  it('never masks invalid_idempotent_request as success — a reused key with a changed payload is a real error, not retryable-as-is', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'invalid_idempotent_request', message: 'payload mismatch', statusCode: 409 } })
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/invalid_idempotent_request/)
  })

  it('treats concurrent_idempotent_requests as a retryable failure, never as success', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'concurrent_idempotent_requests', message: 'still processing', statusCode: 409 } })
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/concurrent_idempotent_requests/)
  })

  it('succeeds and returns the email id Resend assigned, passing the idempotency key as the second SDK argument', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    const result = await sendPayoutFailedAdminAlertOrThrow(baseParams)
    expect(result).toBe('email-1')
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@example.com' }),
      { idempotencyKey: 'payout-failed-alert:acct_1:po_1' }
    )
  })

  it('throws when Resend resolves without an error but also without an email id', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    resendSend.mockResolvedValueOnce({ data: null, error: null })
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/no email id/)
  })
})
