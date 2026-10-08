import { describe, expect, it } from 'vitest'
import { buildBidAcceptedActionEmail } from '@/lib/server/email'

const BASE = {
  to: 'operator@example.com',
  taskTitle: 'European AI community mini-directory',
  taskId: 'e427ab6c-62fa-473f-8e84-93003b13a47f',
  agentId: 'a59193a8-9010-48dd-a860-36523766547a',
  priceEur: 3,
  deliveryHours: 24,
  onboardingRequired: true,
} as const

describe('bid-accepted action email', () => {
  it('gives a legacy pilot agent the exact task-scoped Express onboarding request and fail-closed work gate', () => {
    const payload = buildBidAcceptedActionEmail({ ...BASE, stripeAccountType: 'express' })
    expect(payload.subject).toContain('European AI community mini-directory')
    expect(payload.html).toContain('POST /api/v1/agents/a59193a8-9010-48dd-a860-36523766547a/stripe-onboard')
    expect(payload.html).toContain('&quot;task_id&quot;:&quot;e427ab6c-62fa-473f-8e84-93003b13a47f&quot;')
    expect(payload.html).toContain('funding_status: funded')
    expect(payload.html).toContain('execution_authorized: true')
    expect(payload.html).toContain('status: in_progress')
    expect(payload.html).toContain('Do not start work yet')
    expect(payload.html).toContain('Do not email credentials or identity documents')
  })

  it('does not tell a normal Standard-account task to request legacy task-scoped Express onboarding', () => {
    const payload = buildBidAcceptedActionEmail({ ...BASE, stripeAccountType: 'standard' })
    expect(payload.html).not.toContain('&quot;task_id&quot;')
    expect(payload.html).not.toContain('?task_id=')
    expect(payload.html).toContain('&quot;country&quot;:&quot;&lt;account-holder country&gt;&quot;')
  })

  it('escapes user-controlled task titles in HTML and removes header newlines from the subject', () => {
    const payload = buildBidAcceptedActionEmail({
      ...BASE,
      taskTitle: '<img src=x onerror=alert(1)>\r\nBcc: victim@example.com',
      stripeAccountType: 'express',
    })
    expect(payload.subject).not.toMatch(/[\r\n]/)
    expect(payload.html).not.toContain('<img')
    expect(payload.html).toContain('&lt;img')
  })
})
