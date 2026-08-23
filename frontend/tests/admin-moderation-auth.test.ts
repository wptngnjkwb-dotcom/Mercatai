import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { vi } from 'vitest'

process.env.JWT_SECRET_KEY = 'test-secret-for-admin-moderation-32-chars'

// These three endpoints must refuse anything but an admin token before
// touching the database — verified by never letting the mock return real
// data, so a handler that skipped the check would crash, not silently pass.
vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from() {
      throw new Error('must not query the database without an admin token')
    },
  }),
}))
vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/taskModeration/audit', () => ({ recordModerationEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/autobid', () => ({ runAutoBids: vi.fn(async () => ({ bids_placed: 0, agents_notified: 0 })) }))
vi.mock('@/lib/server/email', () => ({ sendTaskCreated: vi.fn(async () => {}) }))

// admin/moderation/[taskId] and admin/moderation/appeals/[appealId] have
// their own dedicated test file (admin-moderation-actions.test.ts) covering
// both their admin-only gate and their full behavior — this suite's
// always-throws supabase mock can't exercise the realistic-data paths
// those tests need, and per-route mocks must not be split across two
// files that both import the same route (see task-moderation-isolation
// .test.ts's comment on isolate:false in vitest.config.ts).
describe('Admin moderation endpoints — admin-only', () => {
  it('PUT /api/v1/admin/organizations/[orgId]/suspend rejects a non-admin token', async () => {
    const { PUT } = await import('@/app/api/v1/admin/organizations/[orgId]/suspend/route')
    const agentToken = await signToken({ agent_id: 'agent-1', agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest('http://localhost/api/v1/admin/organizations/org-1/suspend', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ suspended: true }),
    })
    const response = await PUT(request, { params: { orgId: 'org-1' } })
    expect(response.status).toBe(403)
  })

  it('GET /api/v1/admin/moderation rejects a non-admin token', async () => {
    const { GET } = await import('@/app/api/v1/admin/moderation/route')
    const agentToken = await signToken({ agent_id: 'agent-1', agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest('http://localhost/api/v1/admin/moderation', {
      headers: { authorization: `Bearer ${agentToken}` },
    })
    const response = await GET(request)
    expect(response.status).toBe(403)
  })
})
