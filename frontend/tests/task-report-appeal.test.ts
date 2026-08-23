import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-report-appeal-32-characters'

const TASK_ID = 'task-report-1'
const AGENT_ID = 'agent-report-1'

let taskRow: Record<string, unknown> = { id: TASK_ID, moderation_status: 'approved' }
const reportInserts: Record<string, unknown>[] = []
let existingReportForAgent = false
// Simulates the existing task_reports rows for this task (their
// reporter_agent_id) and each reporter's owner_org_id — the threshold is
// gated on distinct owner orgs, not raw report count, so tests set both.
let reporterAgentIds: string[] = []
let agentOwnerOrgs: Record<string, string | null> = {}
const taskUpdates: Record<string, unknown>[] = []
const appealInserts: Record<string, unknown>[] = []
let existingPendingAppeal: { id: string } | null = null
let appealInsertError: { code: string } | null = null

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const builder: Record<string, any> = {
        select: () => builder,
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        in: () => builder,
        maybeSingle: async () => {
          if (table === 'task_moderation_appeals') return { data: existingPendingAppeal, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'tasks') return { data: taskRow, error: null }
          if (table === 'task_moderation_appeals') return { data: { id: 'appeal-1', status: 'pending', created_at: '2026-08-22T00:00:00Z' }, error: null }
          return { data: null, error: null }
        },
        insert: (values: Record<string, unknown>) => {
          if (table === 'task_reports') {
            if (existingReportForAgent) {
              return { ...builder, then: (resolve: any) => resolve({ data: null, error: { code: '23505', message: 'duplicate' } }) }
            }
            reportInserts.push(values)
            return { ...builder, then: (resolve: any) => resolve({ data: null, error: null }) }
          }
          if (table === 'task_moderation_appeals') {
            if (appealInsertError) {
              const errBuilder: Record<string, any> = { select: () => errBuilder, single: async () => ({ data: null, error: appealInsertError }) }
              return errBuilder
            }
            appealInserts.push(values)
          }
          return builder
        },
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'task_reports') return resolve({ data: reporterAgentIds.map((id) => ({ reporter_agent_id: id })), error: null })
          if (table === 'agents') return resolve({ data: reporterAgentIds.map((id) => ({ id, owner_org_id: agentOwnerOrgs[id] ?? null })), error: null })
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/taskModeration/audit', () => ({ recordModerationEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/server/email', () => ({ sendModerationAlert: vi.fn(async () => {}), sendTaskCreated: vi.fn(async () => {}) }))
vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/autobid', () => ({ runAutoBids: vi.fn(async () => ({ bids_placed: 0, agents_notified: 0 })) }))

beforeEach(() => {
  taskRow = { id: TASK_ID, moderation_status: 'approved' }
  reportInserts.length = 0
  existingReportForAgent = false
  reporterAgentIds = []
  agentOwnerOrgs = {}
  taskUpdates.length = 0
  appealInserts.length = 0
  existingPendingAppeal = null
  appealInsertError = null
})

describe('POST /api/v1/tasks/[id]/report', () => {
  it('rejects a buyer token — reporting is agent-only', async () => {
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ reason_code: 'SPAM' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(403)
    expect(reportInserts).toHaveLength(0)
  })

  it('rejects an invalid reason_code', async () => {
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const token = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason_code: 'NOT_A_REAL_CODE' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(400)
    expect(reportInserts).toHaveLength(0)
  })

  it('accepts a valid report from an agent', async () => {
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const token = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason_code: 'SPAM', details: 'looks like spam' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.received).toBe(true)
    expect(reportInserts).toHaveLength(1)
    expect(reportInserts[0]).toMatchObject({ task_id: TASK_ID, reporter_agent_id: AGENT_ID, reason_code: 'SPAM' })
  })

  it('rejects a duplicate report from the same agent with 409', async () => {
    existingReportForAgent = true
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const token = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason_code: 'SPAM' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
  })

  it('auto-quarantines an approved task once 3 distinct owner organizations have reported it', async () => {
    reporterAgentIds = ['reporter-1', 'reporter-2', 'reporter-3']
    agentOwnerOrgs = { 'reporter-1': 'org-a', 'reporter-2': 'org-b', 'reporter-3': 'org-c' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const token = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason_code: 'SPAM' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.auto_quarantined).toBe(true)
    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0]).toMatchObject({ moderation_status: 'quarantined' })
  })

  it('the reported abuse vector: 3 reports from agents under the SAME org do NOT auto-quarantine', async () => {
    // Agent registration is instant and self-service — before this fix, 3
    // freshly-registered agents (any owner org) could silently hide any
    // competitor's task. Same raw report count as the case above, but all
    // three reporters share one owner_org_id, so this must not trigger.
    reporterAgentIds = ['sockpuppet-1', 'sockpuppet-2', 'sockpuppet-3']
    agentOwnerOrgs = { 'sockpuppet-1': 'org-attacker', 'sockpuppet-2': 'org-attacker', 'sockpuppet-3': 'org-attacker' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const token = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason_code: 'SPAM' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.auto_quarantined).toBe(false)
    expect(taskUpdates).toHaveLength(0)
  })

  it('does not re-quarantine a task that is already quarantined', async () => {
    taskRow = { id: TASK_ID, moderation_status: 'quarantined' }
    reporterAgentIds = ['reporter-1', 'reporter-2', 'reporter-3', 'reporter-4', 'reporter-5']
    agentOwnerOrgs = { 'reporter-1': 'org-a', 'reporter-2': 'org-b', 'reporter-3': 'org-c', 'reporter-4': 'org-d', 'reporter-5': 'org-e' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/report/route')
    const token = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason_code: 'SPAM' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.auto_quarantined).toBe(false)
    expect(taskUpdates).toHaveLength(0)
  })
})

describe('POST /api/v1/tasks/[id]/appeal', () => {
  it('rejects an agent token — appeals are buyer-token-bound', async () => {
    taskRow = { id: TASK_ID, moderation_status: 'quarantined' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/appeal/route')
    const agentToken = await signToken({ agent_id: AGENT_ID, agent_slug: 'a', tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: 'please review' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(403)
    expect(appealInserts).toHaveLength(0)
  })

  it("rejects a buyer token bound to a different task", async () => {
    taskRow = { id: TASK_ID, moderation_status: 'quarantined' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/appeal/route')
    const otherTaskToken = await signToken({ role: 'buyer', task_id: 'some-other-task', org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${otherTaskToken}` },
      body: JSON.stringify({ message: 'please review' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(403)
    expect(appealInserts).toHaveLength(0)
  })

  it('rejects an appeal on a task with nothing to appeal (approved)', async () => {
    taskRow = { id: TASK_ID, moderation_status: 'approved' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/appeal/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ message: 'please review' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(400)
    expect(appealInserts).toHaveLength(0)
  })

  it('accepts a valid appeal on a quarantined task from its own buyer token', async () => {
    taskRow = { id: TASK_ID, moderation_status: 'quarantined' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/appeal/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ message: 'This was a legitimate research task, please reconsider.' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.status).toBe('pending')
    expect(appealInserts).toHaveLength(1)
    expect(appealInserts[0]).toMatchObject({ task_id: TASK_ID, buyer_org_id: 'org-1', status: 'pending' })
  })

  it('rejects a second appeal while one is already pending', async () => {
    taskRow = { id: TASK_ID, moderation_status: 'quarantined' }
    existingPendingAppeal = { id: 'appeal-existing' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/appeal/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ message: 'please review again' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
    expect(appealInserts).toHaveLength(0)
  })

  it('turns a DB-level unique violation (concurrent submission race) into a clean 409, not a 500', async () => {
    // The pre-check (existingPendingAppeal) passes for both of two
    // concurrent requests before either insert commits — the partial
    // unique index on task_moderation_appeals is what actually prevents
    // the second one, surfacing here as a 23505 from the insert itself.
    taskRow = { id: TASK_ID, moderation_status: 'quarantined' }
    existingPendingAppeal = null
    appealInsertError = { code: '23505' }
    const { POST } = await import('@/app/api/v1/tasks/[id]/appeal/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ message: 'racing the other request' }),
    })
    const response = await POST(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
  })
})
