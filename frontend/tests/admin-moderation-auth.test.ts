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

describe('Admin moderation endpoints — admin-only', () => {
  it('PUT /api/v1/admin/moderation/[taskId] rejects a non-admin token', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/[taskId]/route')
    const agentToken = await signToken({ agent_id: 'agent-1', agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest('http://localhost/api/v1/admin/moderation/task-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ action: 'approve' }),
    })
    const response = await PUT(request, { params: { taskId: 'task-1' } })
    expect(response.status).toBe(403)
  })

  it('PUT /api/v1/admin/moderation/[taskId] rejects an unauthenticated request', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/[taskId]/route')
    const request = new NextRequest('http://localhost/api/v1/admin/moderation/task-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    })
    const response = await PUT(request, { params: { taskId: 'task-1' } })
    expect(response.status).toBe(403)
  })

  it('PUT /api/v1/admin/moderation/appeals/[appealId] rejects a non-admin token', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/appeals/[appealId]/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: 'task-1', org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/admin/moderation/appeals/appeal-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ resolution: 'uphold', statement_of_reasons: 'no basis to overturn' }),
    })
    const response = await PUT(request, { params: { appealId: 'appeal-1' } })
    expect(response.status).toBe(403)
  })

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
