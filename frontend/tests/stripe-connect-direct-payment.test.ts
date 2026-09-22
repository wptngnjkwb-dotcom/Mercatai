import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/payments/stripe-connect-webhook/route'

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test'

const monitoring = vi.hoisted(() => ({
  claimConnectEvent: vi.fn(async () => ({ claimed: true, id: 'event-row-1', claimToken: 'lease-1' })),
  markConnectEventCompleted: vi.fn(async () => {}),
  markConnectEventFailed: vi.fn(async () => {}),
  handleAccountUpdated: vi.fn(async () => {}),
  handlePayoutEvent: vi.fn(async () => {}),
  handleExternalAccountUpdated: vi.fn(async () => {}),
}))
vi.mock('@/lib/server/stripeConnectMonitoring', () => monitoring)

const reconcilePaymentIntent = vi.hoisted(() => vi.fn(async () => 'authorized'))
vi.mock('@/lib/server/paymentState', () => ({ reconcilePaymentIntent }))

const handleDisputeEvent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/server/paymentDisputes', () => ({ handleDisputeEvent }))
vi.mock('@/lib/server/email', () => ({
  buildDisputeAdminAlertProviderPayload: vi.fn(),
  sendDisputeAdminAlertOrThrow: vi.fn(),
}))

const db = { marker: 'db' }
vi.mock('@/lib/server/supabase', () => ({ getSupabase: () => db }))

let parsedEvent: Record<string, any>
const constructEvent = vi.fn((_body: string, signature: string) => {
  if (signature !== 'valid-signature') throw new Error('bad signature')
  return parsedEvent
})
const retrievePaymentIntent = vi.fn(async (id: string, options: Record<string, unknown>) => ({
  id, status: 'requires_capture', latest_charge: 'ch_direct', account_context: options.stripeAccount,
}))
const stripeInstance = {
  webhooks: { constructEvent },
  paymentIntents: { retrieve: retrievePaymentIntent },
}
vi.mock('stripe', () => ({ default: vi.fn(function () { return stripeInstance }) }))

function request(signature = 'valid-signature') {
  return new NextRequest('http://localhost/api/v1/payments/stripe-connect-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: JSON.stringify(parsedEvent),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  parsedEvent = {
    id: 'evt_direct_1',
    type: 'payment_intent.amount_capturable_updated',
    account: 'acct_agent_1',
    data: { object: { id: 'pi_direct_1', status: 'requires_capture' } },
  }
})

describe('connected-account Direct Charge webhook', () => {
  it('re-fetches and reconciles the PaymentIntent in event.account, then completes the event lease', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(retrievePaymentIntent).toHaveBeenCalledWith('pi_direct_1', { stripeAccount: 'acct_agent_1' })
    expect(reconcilePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pi_direct_1', account_context: 'acct_agent_1' }),
      'payment_intent.amount_capturable_updated',
      stripeInstance,
      { chargeModel: 'direct', connectedAccountId: 'acct_agent_1' },
    )
    expect(monitoring.markConnectEventCompleted).toHaveBeenCalledWith(db, 'event-row-1', 'lease-1')
    expect(monitoring.markConnectEventFailed).not.toHaveBeenCalled()
  })

  it('fails closed when a Direct Charge event has no connected-account context', async () => {
    delete parsedEvent.account
    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(retrievePaymentIntent).not.toHaveBeenCalled()
    expect(reconcilePaymentIntent).not.toHaveBeenCalled()
    expect(monitoring.markConnectEventFailed).toHaveBeenCalled()
    expect(monitoring.markConnectEventCompleted).not.toHaveBeenCalled()
  })

  it('returns 500 and leaves the event retryable when transaction reconciliation rejects an account mismatch', async () => {
    reconcilePaymentIntent.mockRejectedValueOnce(new Error('Stripe webhook/payment context does not match the transaction'))
    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(monitoring.markConnectEventFailed).toHaveBeenCalled()
    expect(monitoring.markConnectEventCompleted).not.toHaveBeenCalled()
  })

  it('passes event.account into Direct Charge dispute handling', async () => {
    parsedEvent = {
      id: 'evt_dispute_1',
      type: 'charge.dispute.created',
      account: 'acct_agent_1',
      data: { object: { id: 'dp_direct_1' } },
    }
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(handleDisputeEvent).toHaveBeenCalledWith(
      db,
      stripeInstance,
      parsedEvent,
      expect.objectContaining({
        buildPayload: expect.any(Function),
        sendAlert: expect.any(Function),
      }),
      'acct_agent_1',
    )
  })

  it('rejects an invalid signature before claiming the event', async () => {
    const response = await POST(request('invalid'))
    expect(response.status).toBe(400)
    expect(monitoring.claimConnectEvent).not.toHaveBeenCalled()
  })
})
