import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-admin-actions-32-characters'

const TASK_ID = 'task-admin-actions-1'
const APPEAL_ID = 'appeal-1'

let taskRow: Record<string, unknown> = {
  id: TASK_ID,
  title: 'Some task',
  category: 'research',
  budget_min_eur: 10,
  budget_max_eur: 100,
  deadline_hours: 24,
  required_capabilities: [],
  required_languages: ['en'],
  posted_by_org_id: 'org-1',
  buyer_email: null,
  moderation_status: 'quarantined',
  published_at: null as string | null,
}
let appealRow: Record<string, unknown> = { id: APPEAL_ID, task_id: TASK_ID, status: 'pending' }

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const isFilters: [string, unknown][] = []
      let pendingUpdate: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        is: (field: string, value: unknown) => { isFilters.push([field, value]); return builder },
        update: (values: Record<string, unknown>) => { pendingUpdate = values; return builder },
        single: async () => {
          if (table === 'tasks') {
            if (pendingUpdate) Object.assign(taskRow, pendingUpdate)
            return { data: { ...taskRow }, error: null }
          }
          if (table === 'task_moderation_appeals') {
            if (pendingUpdate) Object.assign(appealRow, pendingUpdate)
            return { data: { ...appealRow }, error: null }
          }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'tasks') {
            // Simulate `WHERE ... AND published_at IS NULL` — the atomic
            // "publish exactly once" guard under test.
            const nullCheckField = isFilters.find(([, v]) => v === null)?.[0]
            if (nullCheckField && (taskRow as any)[nullCheckField] != null) {
              return { data: null, error: null }
            }
            if (pendingUpdate) Object.assign(taskRow, pendingUpdate)
            return { data: { id: taskRow.id }, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          // A plain `await db.from(...).update(...).eq(...)` with no
          // `.select()` chain resolves through here, not single()/
          // maybeSingle() — still needs to actually apply the write for
          // the mock to honestly reflect what the route just did.
          if (table === 'tasks' && pendingUpdate) Object.assign(taskRow, pendingUpdate)
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/taskModeration/audit', () => ({ recordModerationEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/autobid', () => ({ runAutoBids: vi.fn(async () => ({ bids_placed: 0, agents_notified: 0 })) }))
vi.mock('@/lib/server/email', () => ({ sendTaskCreated: vi.fn(async () => {}) }))

beforeEach(() => {
  taskRow = { ...taskRow, moderation_status: 'quarantined', published_at: null }
  appealRow = { id: APPEAL_ID, task_id: TASK_ID, status: 'pending' }
  vi.clearAllMocks()
})

async function adminToken() {
  return signToken({ tier: 'admin' }, '12h')
}

describe('PUT /api/v1/admin/moderation/[taskId] — admin-only + publish-once', () => {
  it('rejects a non-admin token', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/[taskId]/route')
    const agentToken = await signToken({ agent_id: 'agent-1', agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/admin/moderation/${TASK_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ action: 'approve' }),
    })
    const response = await PUT(request, { params: { taskId: TASK_ID } })
    expect(response.status).toBe(403)
  })

  it('approving a never-published task fires webhooks and auto-bid, and sets published_at', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/[taskId]/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const { runAutoBids } = await import('@/lib/server/autobid')
    const token = await adminToken()
    const request = new NextRequest(`http://localhost/api/v1/admin/moderation/${TASK_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'approve' }),
    })
    const response = await PUT(request, { params: { taskId: TASK_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.published).toBe(true)
    expect(fireWebhooks).toHaveBeenCalledTimes(1)
    expect(runAutoBids).toHaveBeenCalledTimes(1)
    expect(taskRow.published_at).not.toBeNull()
  })

  it('the reported bug: approve -> quarantine -> re-approve does NOT re-fire publish side effects', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/[taskId]/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const { runAutoBids } = await import('@/lib/server/autobid')
    const token = await adminToken()

    // 1) First approval — publishes for real.
    await PUT(
      new NextRequest(`http://localhost/api/v1/admin/moderation/${TASK_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve' }),
      }),
      { params: { taskId: TASK_ID } }
    )
    expect(fireWebhooks).toHaveBeenCalledTimes(1)
    expect(taskRow.published_at).not.toBeNull()

    // 2) Reported/quarantined — moderation_status flips but published_at
    //    (a task's own publish history) must stay exactly as it is.
    await PUT(
      new NextRequest(`http://localhost/api/v1/admin/moderation/${TASK_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'quarantine' }),
      }),
      { params: { taskId: TASK_ID } }
    )
    expect(taskRow.moderation_status).toBe('quarantined')
    expect(taskRow.published_at).not.toBeNull()

    // 3) Re-approved by an admin — before the fix, moderation_status alone
    //    decided whether to fire side effects, and it had just flipped
    //    away from 'approved', so this would re-fire task.created and
    //    re-run auto-bid on agents who already saw this task once.
    const response = await PUT(
      new NextRequest(`http://localhost/api/v1/admin/moderation/${TASK_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve' }),
      }),
      { params: { taskId: TASK_ID } }
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.published).toBe(false)
    expect(fireWebhooks).toHaveBeenCalledTimes(1) // still just the one call from step 1
    expect(runAutoBids).toHaveBeenCalledTimes(1)
  })
})

describe('PUT /api/v1/admin/moderation/appeals/[appealId] — admin-only + publish-once', () => {
  it('rejects a non-admin token', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/appeals/[appealId]/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/admin/moderation/appeals/${APPEAL_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ resolution: 'uphold', statement_of_reasons: 'no basis to overturn' }),
    })
    const response = await PUT(request, { params: { appealId: APPEAL_ID } })
    expect(response.status).toBe(403)
  })

  it('overturning a never-published task publishes it and fires side effects once', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/appeals/[appealId]/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const token = await adminToken()
    const request = new NextRequest(`http://localhost/api/v1/admin/moderation/appeals/${APPEAL_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ resolution: 'overturn', statement_of_reasons: 'Legitimate task, reversing the quarantine.' }),
    })
    const response = await PUT(request, { params: { appealId: APPEAL_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.task_moderation_status).toBe('approved')
    expect(fireWebhooks).toHaveBeenCalledTimes(1)
    expect(taskRow.published_at).not.toBeNull()
  })

  it('overturning a task that was already published once (approved -> quarantined -> appealed) does not re-fire side effects', async () => {
    // Simulate the task having gone through a real publish already, before
    // the report/quarantine that led to this appeal.
    taskRow.published_at = '2026-08-01T00:00:00.000Z'

    const { PUT } = await import('@/app/api/v1/admin/moderation/appeals/[appealId]/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const token = await adminToken()
    const request = new NextRequest(`http://localhost/api/v1/admin/moderation/appeals/${APPEAL_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ resolution: 'overturn', statement_of_reasons: 'Reversing the quarantine.' }),
    })
    const response = await PUT(request, { params: { appealId: APPEAL_ID } })

    expect(response.status).toBe(200)
    expect(fireWebhooks).not.toHaveBeenCalled()
  })

  it('upholding an appeal leaves the task quarantined and fires no publish side effects', async () => {
    const { PUT } = await import('@/app/api/v1/admin/moderation/appeals/[appealId]/route')
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    const token = await adminToken()
    const request = new NextRequest(`http://localhost/api/v1/admin/moderation/appeals/${APPEAL_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ resolution: 'uphold', statement_of_reasons: 'The original decision stands.' }),
    })
    const response = await PUT(request, { params: { appealId: APPEAL_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.task_moderation_status).toBe('quarantined')
    expect(fireWebhooks).not.toHaveBeenCalled()
    expect(taskRow.published_at).toBeNull()
  })
})
