import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST } from '@/app/api/v1/bids/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-bids-auth-32-characters!!'

const AGENT_ID = '33333333-3333-3333-3333-333333333333'
const TASK_ID = '44444444-4444-4444-4444-444444444444'

const taskRow = {
  id: TASK_ID,
  status: 'open',
  budget_max_eur: 100,
  deadline_hours: 24,
  title: 'Test task',
  buyer_email: null,
}
const agentRow = { id: AGENT_ID, is_active: true, reputation_score: 50, display_name: 'Test Agent' }

const bidInserts: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (values: Record<string, unknown>) => {
          if (table === 'bids') bidInserts.push(values)
          return builder
        },
        update: () => builder,
        single: async () => {
          if (table === 'tasks') return { data: taskRow, error: null }
          if (table === 'agents') return { data: agentRow, error: null }
          if (table === 'bids') return { data: { id: 'bid-1', ...bidInserts.at(-1) }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/email', () => ({ sendNewBid: vi.fn(async () => {}) }))

function bidRequest(bearer: string, bodyOverrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/v1/bids', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ task_id: TASK_ID, price_eur: 50, delivery_hours: 24, approach_summary: 'test', ...bodyOverrides }),
  })
}

describe('POST /api/v1/bids auth', () => {
  beforeEach(() => {
    bidInserts.length = 0
  })

  it('rejects a refresh token used as a Bearer access token — the reported vulnerability', async () => {
    const refreshToken = await signToken({ agent_id: AGENT_ID, type: 'refresh' }, '7d')
    const response = await POST(bidRequest(refreshToken))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.code).toBe('invalid_token')
    expect(bidInserts).toHaveLength(0)
  })

  it('accepts a genuine access token and submits the bid', async () => {
    const accessToken = await signToken({ agent_id: AGENT_ID, agent_slug: 'test-agent', tier: 1 }, '15m')
    const response = await POST(bidRequest(accessToken))

    expect(response.status).toBe(201)
    expect(bidInserts).toHaveLength(1)
    expect(bidInserts[0]).toMatchObject({ task_id: TASK_ID, agent_id: AGENT_ID, price_eur: 50 })
  })

  it('reports token_expired for an expired access token, distinct from a bad one', async () => {
    const expired = await signToken({ agent_id: AGENT_ID }, Math.floor(Date.now() / 1000) - 10)
    const response = await POST(bidRequest(expired))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.code).toBe('token_expired')
    expect(bidInserts).toHaveLength(0)
  })

  it('rejects a buyer token — the reviewed authorization gap — with zero DB writes', async () => {
    // Same shape POST /api/v1/tasks and the store hire flow issue: a
    // perfectly valid, non-expired, non-refresh token that just isn't an
    // agent. Before this fix it fell through to trusting body.agent_id.
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const response = await POST(bidRequest(buyerToken, { agent_id: AGENT_ID }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(bidInserts).toHaveLength(0)
    expect(body.error).toMatch(/agent or admin/i)
  })

  it('ignores body.agent_id for a genuine agent token — cannot bid as another agent', async () => {
    const accessToken = await signToken({ agent_id: AGENT_ID, agent_slug: 'test-agent', tier: 1 }, '15m')
    const response = await POST(bidRequest(accessToken, { agent_id: 'someone-elses-agent-id' }))

    expect(response.status).toBe(201)
    expect(bidInserts[0]).toMatchObject({ agent_id: AGENT_ID })
  })

  it('lets an admin token submit a bid on an explicitly named agent_id', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await POST(bidRequest(adminToken, { agent_id: AGENT_ID }))

    expect(response.status).toBe(201)
    expect(bidInserts).toHaveLength(1)
    expect(bidInserts[0]).toMatchObject({ agent_id: AGENT_ID })
  })

  it('rejects an admin token with no agent_id in the body as a normal missing-field 400', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await POST(bidRequest(adminToken, { agent_id: undefined }))

    expect(response.status).toBe(400)
    expect(bidInserts).toHaveLength(0)
  })
})
