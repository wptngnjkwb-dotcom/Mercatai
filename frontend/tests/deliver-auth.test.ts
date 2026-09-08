import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST } from '@/app/api/v1/tasks/[id]/deliver/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-deliver-auth-32-characters'

const ASSIGNED_AGENT_ID = '55555555-5555-5555-5555-555555555555'
const OTHER_AGENT_ID = '66666666-6666-6666-6666-666666666666'
const TASK_ID = '77777777-7777-7777-7777-777777777777'

const taskRow = { id: TASK_ID, status: 'in_progress', assigned_agent_id: ASSIGNED_AGENT_ID }
const taskUpdates: Record<string, unknown>[] = []
let assignedAgentVisibility = 'public'

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          return builder
        },
        single: async () => {
          if (table === 'tasks') return { data: taskRow, error: null }
          if (table === 'agents') return { data: { id: ASSIGNED_AGENT_ID, profile_visibility: assignedAgentVisibility }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
const { fireWebhooks } = vi.hoisted(() => ({ fireWebhooks: vi.fn(async (_event: string, _payload: Record<string, unknown>) => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks }))

function deliverRequest(bearer: string) {
  return new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ delivery_note: 'done' }),
  })
}

describe('POST /api/v1/tasks/[id]/deliver auth', () => {
  beforeEach(() => {
    taskUpdates.length = 0
    assignedAgentVisibility = 'public'
    fireWebhooks.mockClear()
  })

  it('lets the assigned agent deliver', async () => {
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })

    expect(response.status).toBe(200)
    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0]).toMatchObject({ status: 'review' })
  })

  it('rejects a different agent\'s token — the reviewed authorization gap — with zero writes', async () => {
    const token = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toMatch(/assigned agent/i)
    expect(taskUpdates).toHaveLength(0)
  })

  it('rejects a buyer token with zero writes', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const response = await POST(deliverRequest(buyerToken), { params: { id: TASK_ID } })

    expect(response.status).toBe(403)
    expect(taskUpdates).toHaveLength(0)
  })

  it('lets an admin token deliver on behalf of any agent', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await POST(deliverRequest(adminToken), { params: { id: TASK_ID } })

    expect(response.status).toBe(200)
    expect(taskUpdates).toHaveLength(1)
  })

  it('includes the real agent_id in the public webhook payload for a public agent', async () => {
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    await POST(deliverRequest(token), { params: { id: TASK_ID } })

    expect(fireWebhooks).toHaveBeenCalledWith('task.delivered', expect.objectContaining({ agent_id: ASSIGNED_AGENT_ID }))
  })

  it('never puts a private agent\'s UUID or agent_id in the public webhook payload', async () => {
    assignedAgentVisibility = 'private'
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    await POST(deliverRequest(token), { params: { id: TASK_ID } })

    expect(fireWebhooks).toHaveBeenCalledTimes(1)
    const payload = fireWebhooks.mock.calls[0][1]
    expect(payload).not.toHaveProperty('agent_id')
    expect(payload).toMatchObject({ agent_private: true })
    expect(JSON.stringify(payload)).not.toContain(ASSIGNED_AGENT_ID)
  })
})
