import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken, verifyToken } from '@/lib/server/auth'
import { POST } from '@/app/api/v1/tasks/[id]/deliver/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-deliver-buyer-notify-32chars'

const ASSIGNED_AGENT_ID = '55555555-5555-5555-5555-555555555555'
const TASK_ID = '77777777-7777-7777-7777-777777777777'
const REVIEW_DEADLINE = '2026-09-03T00:00:00.000Z'

const taskRow: Record<string, any> = {}
let transactionRows: Record<string, any>[] = []
let rpcCalls = 0
let failBuyerLookup = false
let rpcOutcome: 'normal' | 'noop_error' | 'empty' = 'normal'

function resetState() {
  for (const key of Object.keys(taskRow)) delete taskRow[key]
  Object.assign(taskRow, {
    id: TASK_ID,
    title: 'Translate <b>contract</b>',
    status: 'in_progress',
    assigned_agent_id: ASSIGNED_AGENT_ID,
    posted_by_org_id: 'org-real',
    archived_at: null,
    delivery_note: null,
    buyer_email: ' Buyer@Example.com ',
  })
  transactionRows = [{
    id: 'tx-1', task_id: TASK_ID, agent_id: ASSIGNED_AGENT_ID,
    buyer_org_id: 'org-real', escrow_status: 'held', created_at: '2026-09-01T00:00:00.000Z',
  }]
  rpcCalls = 0
  failBuyerLookup = false
  rpcOutcome = 'normal'
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      let columns = '*'
      const rows = () => {
        const all = table === 'tasks' ? [taskRow]
          : table === 'transactions' ? transactionRows
          : table === 'organizations' ? [{ id: 'org-real', is_platform_seed: false }]
          : table === 'agents' ? [{ id: ASSIGNED_AGENT_ID, profile_visibility: 'public' }]
          : []
        return all.filter((row) => eqFilters.every(([f, v]) => row[f] === v))
      }
      const builder: Record<string, any> = {
        select: (cols: string) => { columns = cols; return builder },
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        in: () => builder,
        maybeSingle: async () => {
          if (table === 'tasks' && failBuyerLookup && columns.includes('buyer_email')) {
            return { data: null, error: { code: 'XX000', message: 'simulated' } }
          }
          return { data: rows()[0] ?? null, error: null }
        },
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
      }
      return builder
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name !== 'submit_funded_task_delivery') throw new Error(`unexpected RPC ${name}`)
      rpcCalls += 1
      if (rpcOutcome === 'noop_error') return { data: null, error: { code: 'P0001', message: 'task changed during delivery' } }
      if (rpcOutcome === 'empty') return { data: [], error: null }
      const tx = transactionRows[0]
      // Mirrors the real RPC: anything but a fresh in_progress + held
      // delivery (e.g. an already-delivered task) raises P0001, a no-op.
      if (taskRow.status !== 'in_progress' || tx?.escrow_status !== 'held') {
        return { data: null, error: { code: 'P0001', message: 'not authorized' } }
      }
      Object.assign(tx, { review_deadline_at: REVIEW_DEADLINE })
      Object.assign(taskRow, { status: 'review', delivery_note: String(args.p_delivery_note).trim() })
      return { data: [{ task_id: TASK_ID, task_status: 'review', review_deadline_at: REVIEW_DEADLINE }], error: null }
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
const { sendTaskDelivered } = vi.hoisted(() => ({ sendTaskDelivered: vi.fn(async (_params: Record<string, any>) => {}) }))
vi.mock('@/lib/server/email', () => ({ sendTaskDelivered }))

function deliverRequest(bearer: string, deliveryNote = 'Here is the translated contract.') {
  return new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ delivery_note: deliveryNote }),
  })
}

const agentToken = () => signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')

describe('POST /api/v1/tasks/[id]/deliver — buyer delivery notification', () => {
  beforeEach(() => {
    resetState()
    sendTaskDelivered.mockReset()
    sendTaskDelivered.mockImplementation(async () => {})
  })

  it('sends exactly one email to the stored buyer address on a successful delivery', async () => {
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(200)
    expect(sendTaskDelivered).toHaveBeenCalledTimes(1)
    const params = sendTaskDelivered.mock.calls[0][0]
    expect(params).toMatchObject({
      to: 'buyer@example.com',
      taskTitle: 'Translate <b>contract</b>',
      taskId: TASK_ID,
      reviewDeadlineAt: REVIEW_DEADLINE,
    })
    // Never carries the delivered work itself.
    expect(JSON.stringify(params)).not.toContain('translated contract')
    // The link token is the existing task-scoped buyer credential.
    const claims = await verifyToken(params.buyerToken)
    expect(claims).toMatchObject({ role: 'buyer', task_id: TASK_ID, org_id: 'org-real', buyer_email: 'buyer@example.com' })
    expect(claims).not.toHaveProperty('agent_id')
  })

  it('sends no second email for a duplicate delivery of an already-delivered task', async () => {
    const token = await agentToken()
    expect((await POST(deliverRequest(token), { params: { id: TASK_ID } })).status).toBe(200)
    const duplicate = await POST(deliverRequest(token, 'again'), { params: { id: TASK_ID } })
    expect(duplicate.status).toBe(409)
    expect(sendTaskDelivered).toHaveBeenCalledTimes(1)
  })

  it('sends no email when the atomic RPC reports a no-op (state changed after the pre-check)', async () => {
    rpcOutcome = 'noop_error'
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(409)
    expect(rpcCalls).toBe(1)
    expect(sendTaskDelivered).not.toHaveBeenCalled()
  })

  it('sends no email when the RPC returns no confirmed transition', async () => {
    rpcOutcome = 'empty'
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(500)
    expect(sendTaskDelivered).not.toHaveBeenCalled()
  })

  it('two concurrent deliveries send exactly one email', async () => {
    const token = await agentToken()
    const responses = await Promise.all([
      POST(deliverRequest(token, 'first'), { params: { id: TASK_ID } }),
      POST(deliverRequest(token, 'second'), { params: { id: TASK_ID } }),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(sendTaskDelivered).toHaveBeenCalledTimes(1)
  })

  it('sends no email when delivery is rejected before the RPC (unfunded)', async () => {
    transactionRows[0].escrow_status = 'pending'
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(402)
    expect(sendTaskDelivered).not.toHaveBeenCalled()
  })

  it('still succeeds when the email send throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    sendTaskDelivered.mockImplementation(async () => { throw new Error('resend down') })
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: TASK_ID, status: 'review', review_deadline_at: REVIEW_DEADLINE })
    expect(taskRow.status).toBe('review')
    expect(sendTaskDelivered).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('still succeeds, without emailing, when the buyer lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    failBuyerLookup = true
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(200)
    expect(sendTaskDelivered).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it.each([null, '', 'not-an-email'])('skips the email gracefully when buyer_email is %j', async (email) => {
    taskRow.buyer_email = email
    const response = await POST(deliverRequest(await agentToken()), { params: { id: TASK_ID } })
    expect(response.status).toBe(200)
    expect(sendTaskDelivered).not.toHaveBeenCalled()
  })
})
