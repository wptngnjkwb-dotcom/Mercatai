import { describe, expect, it } from 'vitest'
import { POST } from '@/app/api/v1/payments/release/[taskId]/route'

describe('legacy payment release endpoint', () => {
  it('is permanently non-mutating and directs callers to buyer approval', async () => {
    const response = await POST()

    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      canonical_endpoint: '/api/v1/tasks/{id}/approve',
    })
  })
})
