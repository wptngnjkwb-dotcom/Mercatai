import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST } from '@/app/api/v1/tasks/[id]/deliver/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-deliver-auth-32-characters'

const ASSIGNED_AGENT_ID = '55555555-5555-5555-5555-555555555555'
const OTHER_AGENT_ID = '66666666-6666-6666-6666-666666666666'
const TASK_ID = '77777777-7777-7777-7777-777777777777'
const DELIVERY_NOTE_MAX_LENGTH = 50_000

const taskRow: Record<string, any> = {
  id: TASK_ID,
  status: 'in_progress',
  assigned_agent_id: ASSIGNED_AGENT_ID,
  posted_by_org_id: 'org-real',
  archived_at: null,
  delivery_note: null,
}
const taskUpdates: Record<string, unknown>[] = []
let assignedAgentVisibility = 'public'
let seedOrg = false
let transactionRows: Record<string, any>[] = []
let taskWriteCount = 0
let transactionWriteCount = 0
let failAtomicDelivery = false

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const inFilters: [string, unknown[]][] = []
      let pendingUpdate: Record<string, unknown> | null = null
      const allRows = () => {
        if (table === 'tasks') return [taskRow]
        if (table === 'transactions') return transactionRows
        if (table === 'organizations') return [{ id: 'org-real', is_platform_seed: seedOrg }]
        if (table === 'agents') return [{ id: ASSIGNED_AGENT_ID, profile_visibility: assignedAgentVisibility }]
        return []
      }
      const matching = () => allRows().filter((row) =>
        eqFilters.every(([field, value]) => row[field] === value)
        && inFilters.every(([field, values]) => values.includes(row[field]))
      )
      const applyUpdate = () => {
        if (!pendingUpdate) return []
        const rows = matching()
        rows.forEach((row) => Object.assign(row, pendingUpdate))
        if (table === 'tasks') taskWriteCount += rows.length
        if (table === 'transactions') transactionWriteCount += rows.length
        return rows
      }
      const builder: Record<string, any> = {
        select: () => builder,
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        in: (field: string, values: unknown[]) => { inFilters.push([field, values]); return builder },
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          pendingUpdate = values
          return builder
        },
        single: async () => ({ data: matching()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: pendingUpdate ? applyUpdate()[0] ?? null : matching()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: pendingUpdate ? applyUpdate() : matching(), error: null }),
      }
      return builder
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name !== 'submit_funded_task_delivery') throw new Error(`unexpected RPC ${name}`)
      if (failAtomicDelivery) {
        return { data: null, error: { code: 'XX000', message: 'simulated transactional failure' } }
      }
      const latestTx = [...transactionRows].sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))
      )[0]
      if (
        taskRow.status !== 'in_progress'
        || taskRow.archived_at
        || seedOrg
        || taskRow.assigned_agent_id !== args.p_expected_agent_id
        || latestTx?.escrow_status !== 'held'
        || latestTx?.agent_id !== taskRow.assigned_agent_id
        || latestTx?.buyer_org_id !== taskRow.posted_by_org_id
      ) {
        return { data: null, error: { code: 'P0001', message: 'not authorized' } }
      }

      const reviewDeadline = '2026-09-03T00:00:00.000Z'
      Object.assign(latestTx, { review_deadline_at: reviewDeadline })
      Object.assign(taskRow, { status: 'review', delivery_note: String(args.p_delivery_note).trim() })
      taskUpdates.push({ status: 'review', delivery_note: String(args.p_delivery_note).trim() })
      taskWriteCount += 1
      transactionWriteCount += 1
      return { data: [{ task_id: TASK_ID, task_status: 'review', review_deadline_at: reviewDeadline }], error: null }
    },
  }),
}))

const { auditLog } = vi.hoisted(() => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/audit', () => ({ auditLog }))
const { fireWebhooks } = vi.hoisted(() => ({ fireWebhooks: vi.fn(async (_event: string, _payload: Record<string, unknown>) => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks }))

function deliverRequest(bearer: string, deliveryNote: unknown = 'done') {
  return new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ delivery_note: deliveryNote }),
  })
}

describe('POST /api/v1/tasks/[id]/deliver auth', () => {
  beforeEach(() => {
    Object.assign(taskRow, { status: 'in_progress', assigned_agent_id: ASSIGNED_AGENT_ID, posted_by_org_id: 'org-real', archived_at: null, delivery_note: null })
    transactionRows = [{
      id: 'tx-1', task_id: TASK_ID, agent_id: ASSIGNED_AGENT_ID,
      buyer_org_id: 'org-real', escrow_status: 'held',
      created_at: '2026-09-01T00:00:00.000Z',
    }]
    taskUpdates.length = 0
    assignedAgentVisibility = 'public'
    seedOrg = false
    taskWriteCount = 0
    transactionWriteCount = 0
    failAtomicDelivery = false
    auditLog.mockClear()
    fireWebhooks.mockClear()
  })

  it('lets the assigned agent deliver', async () => {
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })

    expect(response.status).toBe(200)
    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0]).toMatchObject({ status: 'review' })
    expect(taskRow.delivery_note).toBe('done')
    expect(taskWriteCount).toBe(1)
    expect(transactionWriteCount).toBe(1)
  })

  it.each(['pending', 'failed', 'refunded'])(
    'rejects in_progress with escrow=%s with no writes, audit, or webhook',
    async (escrowStatus) => {
      transactionRows[0].escrow_status = escrowStatus
      const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
      const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })
      const body = await response.json()
      expect([402, 409]).toContain(response.status)
      expect(body.execution_authorized).toBe(false)
      expect(taskWriteCount + transactionWriteCount).toBe(0)
      expect(auditLog).not.toHaveBeenCalled()
      expect(fireWebhooks).not.toHaveBeenCalled()
    }
  )

  it('rejects demo + in_progress + funded with no side effects', async () => {
    seedOrg = true
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ execution_authorized: false, next_action: 'ignore_demo' })
    expect(taskWriteCount + transactionWriteCount).toBe(0)
    expect(fireWebhooks).not.toHaveBeenCalled()
  })

  it('rejects archived + in_progress + funded with no side effects', async () => {
    taskRow.archived_at = '2026-09-01T00:00:00.000Z'
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
    expect(taskWriteCount + transactionWriteCount).toBe(0)
    expect(fireWebhooks).not.toHaveBeenCalled()
  })

  it('rejects delivery when the held Stripe transaction belongs to another agent', async () => {
    transactionRows[0].agent_id = OTHER_AGENT_ID
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
    expect(taskWriteCount + transactionWriteCount).toBe(0)
    expect(auditLog).not.toHaveBeenCalled()
    expect(fireWebhooks).not.toHaveBeenCalled()
  })

  it('rolls back both rows and runs no effects when the atomic delivery fails', async () => {
    failAtomicDelivery = true
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token), { params: { id: TASK_ID } })
    expect(response.status).toBe(500)
    expect(taskRow).toMatchObject({ status: 'in_progress', delivery_note: null })
    expect(transactionRows[0].review_deadline_at).toBeUndefined()
    expect(taskWriteCount + transactionWriteCount).toBe(0)
    expect(auditLog).not.toHaveBeenCalled()
    expect(fireWebhooks).not.toHaveBeenCalled()
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

  it('two concurrent deliveries produce only one transition and one set of effects', async () => {
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const responses = await Promise.all([
      POST(deliverRequest(token, 'first delivery'), { params: { id: TASK_ID } }),
      POST(deliverRequest(token, 'second delivery'), { params: { id: TASK_ID } }),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(taskWriteCount).toBe(1)
    expect(transactionWriteCount).toBe(1)
    expect(auditLog).toHaveBeenCalledTimes(1)
    expect(fireWebhooks).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['empty', '   '],
    ['non-string', 42],
    ['too long', 'x'.repeat(DELIVERY_NOTE_MAX_LENGTH + 1)],
  ])('rejects an %s delivery_note before any write', async (_label, note) => {
    const token = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const response = await POST(deliverRequest(token, note), { params: { id: TASK_ID } })
    expect(response.status).toBe(400)
    expect(taskWriteCount + transactionWriteCount).toBe(0)
    expect(fireWebhooks).not.toHaveBeenCalled()
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
