import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST as openIssue, GET as listIssues } from '@/app/api/v1/tasks/[id]/issues/route'
import { POST as postMessage } from '@/app/api/v1/tasks/[id]/issues/[issueId]/messages/route'
import { POST as acceptRefund } from '@/app/api/v1/tasks/[id]/issues/[issueId]/accept-refund/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-quality-issues-32-chars'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'

const TASK_ID = '11111111-1111-1111-1111-111111111111'
const ISSUE_ID = '33333333-3333-3333-3333-333333333333'
const BUYER_ORG_ID = '44444444-4444-4444-4444-444444444444'
const AGENT_ID = '55555555-5555-5555-5555-555555555555'
const OTHER_AGENT_ID = '66666666-6666-6666-6666-666666666666'
const TX_ID = '77777777-7777-7777-7777-777777777777'

let taskRow: Record<string, unknown> | null = { id: TASK_ID, assigned_agent_id: AGENT_ID }
let issueRow: Record<string, unknown> | null = {
  id: ISSUE_ID,
  task_id: TASK_ID,
  status: 'open',
  opened_by_org_id: BUYER_ORG_ID,
  assigned_agent_id: AGENT_ID,
}
let issuesListRows: Record<string, unknown>[] = []
let txRow: Record<string, unknown> | null = null
let insertedMessage: Record<string, unknown> | null = null
let insertMessageShouldFail = false

const rpcMock = vi.fn()

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        insert: (obj: Record<string, unknown>) => {
          if (table === 'quality_issue_messages') {
            insertedMessage = insertMessageShouldFail ? null : { id: 'msg-new', author_role: obj.author_role, message: obj.message, created_at: new Date().toISOString() }
          }
          return builder
        },
        single: async () => {
          if (table === 'quality_issue_messages') {
            return { data: insertedMessage, error: insertedMessage ? null : { message: 'insert failed' } }
          }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'tasks') return { data: taskRow, error: null }
          if (table === 'quality_issues') return { data: issueRow, error: null }
          if (table === 'transactions') return { data: txRow, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'quality_issues') return resolve({ data: issuesListRows, error: null })
          if (table === 'audit_logs') return resolve({ count: 0, data: [], error: null })
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
    rpc: rpcMock,
  }),
}))

const stripeRetrieve = vi.fn(async () => ({ status: 'requires_capture' }))
const stripeCancel = vi.fn(async () => ({ id: 'pi_test', status: 'canceled' }))
const stripeRefundsCreate = vi.fn(async () => ({ id: 're_test' }))
const stripeConstructor = vi.fn(function () {
  return {
    paymentIntents: { retrieve: stripeRetrieve, cancel: stripeCancel },
    refunds: { create: stripeRefundsCreate },
  }
})
vi.mock('stripe', () => ({ default: stripeConstructor }))

function buyerToken() {
  return signToken({ role: 'buyer', task_id: TASK_ID, org_id: BUYER_ORG_ID }, '15m')
}
function agentToken(agentId = AGENT_ID) {
  return signToken({ agent_id: agentId, tier: 1 }, '15m')
}

function req(url: string, bearer?: string, body?: object) {
  return new NextRequest(`http://localhost${url}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  taskRow = { id: TASK_ID, assigned_agent_id: AGENT_ID }
  issueRow = { id: ISSUE_ID, task_id: TASK_ID, status: 'open', opened_by_org_id: BUYER_ORG_ID, assigned_agent_id: AGENT_ID }
  issuesListRows = []
  txRow = null
  insertedMessage = null
  insertMessageShouldFail = false
  rpcMock.mockReset()
  stripeRetrieve.mockClear().mockImplementation(async () => ({ status: 'requires_capture' }))
  stripeCancel.mockClear()
  stripeRefundsCreate.mockClear()
  stripeConstructor.mockClear()
})

describe('POST /api/v1/tasks/{id}/issues — opening never itself moves money', () => {
  it('lets the task-bound buyer open a quality issue', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ issue_id: ISSUE_ID, status: 'open', response_deadline_at: '2026-10-01T00:00:00Z', deadline_extended: true }],
      error: null,
    })
    const token = await buyerToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'not_as_described', initial_message: 'Missing the requested section.' }), { params: { id: TASK_ID } })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toBe(ISSUE_ID)
    expect(body.deadline_extended).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('open_quality_issue', expect.objectContaining({
      p_task_id: TASK_ID, p_opened_by_org_id: BUYER_ORG_ID, p_reason_code: 'not_as_described',
    }))
    // The one RPC call is the only interaction with anything money-adjacent —
    // no Stripe constructor was ever touched.
    expect(stripeConstructor).not.toHaveBeenCalled()
  })

  it('rejects an anonymous request before ever calling the RPC', async () => {
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, undefined, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("rejects a different task's buyer token", async () => {
    const token = await signToken({ role: 'buyer', task_id: 'other-task', org_id: BUYER_ORG_ID }, '15m')
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(403)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('rejects an agent token — only the buyer can open a quality issue', async () => {
    const token = await agentToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(403)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('rejects an admin token — this is deliberately not an admin-openable action either', async () => {
    const token = await signToken({ tier: 'admin' }, '12h')
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(403)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid reason_code before calling the RPC', async () => {
    const token = await buyerToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'buyer_just_changed_their_mind', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('rejects an empty initial_message before calling the RPC', async () => {
    const token = await buyerToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: '   ' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('maps a concurrent-open unique-constraint violation (23505) to 409, not a 500', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' } })
    const token = await buyerToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(409)
  })

  it('maps "task not eligible" (P0001 — demo/archived/wrong-status/etc.) to 409, never silently succeeding', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'task is not eligible for a quality issue' } })
    const token = await buyerToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(409)
  })

  it('maps task-not-found (P0002) to 404', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'task not found' } })
    const token = await buyerToken()
    const res = await openIssue(req(`/api/v1/tasks/${TASK_ID}/issues`, token, { reason_code: 'other', initial_message: 'x' }), { params: { id: TASK_ID } })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/tasks/{id}/issues — private to buyer/assigned agent/admin, never leaks identity', () => {
  beforeEach(() => {
    issuesListRows = [{
      id: ISSUE_ID, task_id: TASK_ID, status: 'open', reason_code: 'other', initial_message: 'hi',
      opened_at: '2026-09-27T00:00:00Z', response_deadline_at: '2026-09-30T00:00:00Z', resolved_at: null, resolution: null,
      quality_issue_messages: [{ id: 'm1', author_role: 'buyer', message: 'a reply', created_at: '2026-09-27T01:00:00Z' }],
    }]
  })

  it('lets the task-bound buyer read the thread', async () => {
    const token = await buyerToken()
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`, token), { params: { id: TASK_ID } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0].messages).toHaveLength(1)
  })

  it('lets the assigned agent read the thread', async () => {
    const token = await agentToken()
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`, token), { params: { id: TASK_ID } })
    expect(res.status).toBe(200)
  })

  it('lets an admin read the thread (safety review only)', async () => {
    const token = await signToken({ tier: 'admin' }, '12h')
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`, token), { params: { id: TASK_ID } })
    expect(res.status).toBe(200)
  })

  it('rejects a different agent — not the one assigned to this task', async () => {
    const token = await agentToken(OTHER_AGENT_ID)
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`, token), { params: { id: TASK_ID } })
    expect(res.status).toBe(403)
  })

  it("rejects a different task's buyer token", async () => {
    const token = await signToken({ role: 'buyer', task_id: 'other-task', org_id: BUYER_ORG_ID }, '15m')
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`, token), { params: { id: TASK_ID } })
    expect(res.status).toBe(403)
  })

  it('rejects an anonymous request', async () => {
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`), { params: { id: TASK_ID } })
    expect(res.status).toBe(401)
  })

  it('never returns the other side\'s organization or agent id — only author_role per message', async () => {
    const token = await buyerToken()
    const res = await listIssues(req(`/api/v1/tasks/${TASK_ID}/issues`, token), { params: { id: TASK_ID } })
    const raw = await res.text()
    expect(raw).not.toContain(BUYER_ORG_ID)
    expect(raw).not.toContain(AGENT_ID)
    expect(raw).not.toContain('opened_by_org_id')
    expect(raw).not.toContain('author_org_id')
    expect(raw).not.toContain('author_agent_id')
  })
})

describe('POST /api/v1/tasks/{id}/issues/{issueId}/messages — private thread, buyer/agent only, open issues only', () => {
  it('lets the buyer post a message', async () => {
    const token = await buyerToken()
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: 'Can you clarify?' }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.author_role).toBe('buyer')
  })

  it('lets the assigned agent post a message', async () => {
    const token = await agentToken()
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: 'Sure, here it is.' }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.author_role).toBe('agent')
  })

  it('rejects a different agent — 403, not silently accepted', async () => {
    const token = await agentToken(OTHER_AGENT_ID)
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: 'x' }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(403)
  })

  it('rejects posting to an already-resolved issue', async () => {
    issueRow = { ...issueRow, status: 'buyer_approved' }
    const token = await buyerToken()
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: 'x' }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(409)
  })

  it('rejects an empty message', async () => {
    const token = await buyerToken()
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: '  ' }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(400)
  })

  it('rejects a message over the length cap', async () => {
    const token = await buyerToken()
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: 'x'.repeat(5001) }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(400)
  })

  it('404s for a quality issue that does not belong to this task', async () => {
    issueRow = { ...issueRow, task_id: 'some-other-task' }
    const token = await buyerToken()
    const res = await postMessage(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/messages`, token, { message: 'x' }), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/tasks/{id}/issues/{issueId}/accept-refund — the ONLY way a quality issue refunds, agent-only', () => {
  beforeEach(() => {
    txRow = {
      id: TX_ID, task_id: TASK_ID, escrow_status: 'held', stripe_payment_intent_id: 'pi_test123',
      gross_amount_eur: 50, stripe_charge_model: 'direct', stripe_connected_account_id: 'acct_test',
    }
  })

  it('lets the assigned agent voluntarily accept a full refund', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ task_status: 'cancelled', transaction_status: 'refunded', newly_refunded: true }], error: null })
    const token = await agentToken()
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.escrow_status).toBe('refunded')
    expect(stripeCancel).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('finalize_task_refund', expect.objectContaining({
      p_task_id: TASK_ID, p_transaction_id: TX_ID, p_outcome: 'quality_issue_agent_refund',
    }))
  })

  it('refunds the full application fee when the payment already succeeded (settled SEPA)', async () => {
    stripeRetrieve.mockImplementation(async () => ({ status: 'succeeded' }))
    rpcMock.mockResolvedValueOnce({ data: [{ task_status: 'cancelled', transaction_status: 'refunded', newly_refunded: true }], error: null })
    const token = await agentToken()
    await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })

    expect(stripeRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_test123', refund_application_fee: true }),
      expect.anything()
    )
  })

  it('rejects the buyer — only the agent can voluntarily accept', async () => {
    const token = await buyerToken()
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(403)
    expect(stripeConstructor).not.toHaveBeenCalled()
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('rejects an admin token — Mercatai cannot force this outcome either', async () => {
    const token = await signToken({ tier: 'admin' }, '12h')
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(403)
    expect(stripeConstructor).not.toHaveBeenCalled()
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('rejects a different agent', async () => {
    const token = await agentToken(OTHER_AGENT_ID)
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(403)
  })

  it('rejects an already-resolved issue', async () => {
    issueRow = { ...issueRow, status: 'expired' }
    const token = await agentToken()
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(409)
    expect(stripeConstructor).not.toHaveBeenCalled()
  })

  it('404s when there is no held transaction for this task', async () => {
    txRow = null
    const token = await agentToken()
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(404)
  })

  it('returns a safely-retryable 500 (not a false success) when Stripe succeeds but DB finalization fails', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } })
    const token = await agentToken()
    const res = await acceptRefund(req(`/api/v1/tasks/${TASK_ID}/issues/${ISSUE_ID}/accept-refund`, token, {}), { params: { id: TASK_ID, issueId: ISSUE_ID } })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/must be retried/i)
  })
})
