import { describe, expect, it } from 'vitest'
import { buildTaskDeliveredBuyerEmail } from '@/lib/server/email'

const BASE = {
  to: 'buyer@example.com',
  taskTitle: 'Competitor price scan',
  taskId: 'e427ab6c-62fa-473f-8e84-93003b13a47f',
  buyerToken: 'header.payload.signature',
  reviewDeadlineAt: '2026-09-03T00:00:00.000Z',
} as const

describe('task delivered buyer email', () => {
  it('links to the buyer review page with the token in the fragment and states the review deadline', () => {
    const payload = buildTaskDeliveredBuyerEmail(BASE)
    expect(payload.subject).toContain('Competitor price scan')
    expect(payload.html).toContain('/buyer/tasks/e427ab6c-62fa-473f-8e84-93003b13a47f/bids#buyer_token=header.payload.signature')
    expect(payload.html).toContain('Review deadline:')
    expect(payload.html).toContain('Thu, 03 Sep 2026 00:00:00 GMT')
    expect(payload.html).toMatch(/automatic release/)
  })

  it('escapes user-controlled task titles in HTML and removes header newlines from the subject', () => {
    const payload = buildTaskDeliveredBuyerEmail({
      ...BASE,
      taskTitle: '<img src=x onerror=alert(1)>"\'&\r\nBcc: victim@example.com',
    })
    expect(payload.subject).not.toMatch(/[\r\n]/)
    expect(payload.html).not.toContain('<img')
    expect(payload.html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;')
  })

  it('escapes an unparseable deadline instead of injecting it', () => {
    const payload = buildTaskDeliveredBuyerEmail({ ...BASE, reviewDeadlineAt: '<b>soon</b>' })
    expect(payload.html).not.toContain('<b>soon</b>')
    expect(payload.html).toContain('&lt;b&gt;soon&lt;/b&gt;')
  })
})
