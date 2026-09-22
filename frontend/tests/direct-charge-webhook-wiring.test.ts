import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const connectWebhook = readFileSync(
  join(ROOT, 'app/api/v1/payments/stripe-connect-webhook/route.ts'),
  'utf8',
)
const platformWebhook = readFileSync(
  join(ROOT, 'app/api/v1/payments/stripe-webhook/route.ts'),
  'utf8',
)

describe('Direct Charge webhook routing', () => {
  it('re-fetches connected-account PaymentIntents under event.account and passes the same immutable context to reconciliation', () => {
    expect(connectWebhook).toContain("event.type.startsWith('payment_intent.')")
    expect(connectWebhook).toContain('if (!event.account)')
    expect(connectWebhook).toContain(
      'stripe.paymentIntents.retrieve(eventIntent.id, { stripeAccount: event.account })',
    )
    expect(connectWebhook).toContain("chargeModel: 'direct'")
    expect(connectWebhook).toContain('connectedAccountId: event.account')
  })

  it('routes connected-account disputes with event.account instead of treating them as platform disputes', () => {
    expect(connectWebhook).toContain('DISPUTE_EVENT_TYPES.has(event.type)')
    expect(connectWebhook).toContain('handleDisputeEvent(db, stripe, event')
    expect(connectWebhook).toMatch(/handleDisputeEvent[\s\S]*event\.account\)/)
  })

  it('keeps the platform webhook for legacy destination-charge rows', () => {
    expect(platformWebhook).toContain('legacy destination charges')
    expect(platformWebhook).not.toContain("chargeModel: 'direct'")
  })
})
