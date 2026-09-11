import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sendPayoutFailedAdminAlertOrThrow } from '@/lib/server/email'

// Deliberately does NOT mock @/lib/server/supabase or 'stripe' — this file
// tests sendPayoutFailedAdminAlertOrThrow in isolation, exercising the
// REAL function (only its 'resend' dependency is mocked), because the
// requirement under test is specifically that THIS function throws rather
// than silently logging "skipping" the way the general-purpose `send()`
// helper in the same module does for every other, non-critical template.

const resendSend = vi.fn(async () => ({ id: 'email-1' }))
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

  it('propagates a real Resend API failure rather than swallowing it', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    resendSend.mockRejectedValueOnce(new Error('Resend API unavailable'))
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).rejects.toThrow(/Resend API unavailable/)
  })

  it('succeeds silently (resolves) when properly configured and Resend accepts the send', async () => {
    process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
    process.env.RESEND_API_KEY = 'test-key'
    await expect(sendPayoutFailedAdminAlertOrThrow(baseParams)).resolves.toBeUndefined()
    expect(resendSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com' }))
  })
})
