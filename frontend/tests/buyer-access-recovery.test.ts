import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

process.env.JWT_SECRET_KEY = 'test-secret-for-buyer-recovery-32chars'

let taskRow: Record<string, unknown> | null = {
  id: 'task-1',
  title: 'Research task',
  buyer_email: 'buyer@example.com',
  posted_by_org_id: 'org-1',
  archived_at: null,
}
let dbError: Record<string, unknown> | null = null

const { sendBuyerAccessRecovery, auditLog, isRateLimited } = vi.hoisted(() => ({
  sendBuyerAccessRecovery: vi.fn(async (_params: { to: string; taskTitle: string; taskId: string; buyerToken: string }) => {}),
  auditLog: vi.fn(async () => {}),
  isRateLimited: vi.fn(async () => false),
}))

vi.mock('@/lib/server/email', () => ({ sendBuyerAccessRecovery }))
vi.mock('@/lib/server/audit', () => ({ auditLog }))
vi.mock('@/lib/server/rateLimit', () => ({
  clientIp: () => '203.0.113.10',
  isRateLimited,
}))
vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from: () => {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: taskRow, error: dbError }),
      }
      return builder
    },
  }),
}))

function request(email: string) {
  return new NextRequest('http://localhost/api/v1/tasks/task-1/buyer-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

describe('POST /api/v1/tasks/{id}/buyer-access', () => {
  beforeEach(() => {
    taskRow = {
      id: 'task-1', title: 'Research task', buyer_email: 'buyer@example.com',
      posted_by_org_id: 'org-1', archived_at: null,
    }
    dbError = null
    sendBuyerAccessRecovery.mockClear()
    auditLog.mockClear()
    isRateLimited.mockReset().mockResolvedValue(false)
  })

  it('emails a new task-scoped token only to an exact normalized match and never returns it', async () => {
    const { POST } = await import('@/app/api/v1/tasks/[id]/buyer-access/route')
    const response = await POST(request(' BUYER@EXAMPLE.COM '), { params: { id: 'task-1' } })
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(JSON.stringify(body)).not.toContain('eyJ')
    expect(sendBuyerAccessRecovery).toHaveBeenCalledTimes(1)
    const sent = sendBuyerAccessRecovery.mock.calls[0][0]
    expect(sent).toMatchObject({ to: 'buyer@example.com', taskId: 'task-1' })
    expect(sent.buyerToken).toEqual(expect.any(String))
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'buyer_access_requested', resource_id: 'task-1', ip_address: '203.0.113.10', details: {},
    }))
  })

  it('uses the identical enumeration-safe response for a wrong email, missing task and DB read error', async () => {
    const { POST } = await import('@/app/api/v1/tasks/[id]/buyer-access/route')
    const bodies: unknown[] = []
    for (const setup of [
      () => { taskRow = { ...taskRow!, buyer_email: 'someone-else@example.com' } },
      () => { taskRow = null },
      () => { taskRow = null; dbError = { message: 'private database detail' } },
    ]) {
      setup()
      const response = await POST(request('buyer@example.com'), { params: { id: 'task-1' } })
      expect(response.status).toBe(202)
      bodies.push(await response.json())
    }
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
    expect(sendBuyerAccessRecovery).not.toHaveBeenCalled()
  })

  it('rate limits before looking up or emailing a task', async () => {
    isRateLimited.mockResolvedValue(true)
    const { POST } = await import('@/app/api/v1/tasks/[id]/buyer-access/route')
    const response = await POST(request('buyer@example.com'), { params: { id: 'task-1' } })
    expect(response.status).toBe(429)
    expect(sendBuyerAccessRecovery).not.toHaveBeenCalled()
    expect(auditLog).not.toHaveBeenCalled()
  })
})
