import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { GET as agentPayoutsGet } from '@/app/api/v1/agents/[id]/payouts/route'
import { GET as adminPayoutsGet } from '@/app/api/v1/admin/payouts/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-stripe-connect-payouts-api-32ch'

const AGENT_1 = '11111111-1111-1111-1111-111111111111'
const AGENT_2 = '22222222-2222-2222-2222-222222222222'

const payoutRows = [
  { id: 'p1', stripe_payout_id: 'po_1', stripe_account_id: 'acct_1', agent_id: AGENT_1, amount_minor: 10000, currency: 'eur', status: 'paid', arrival_date: null, failure_code: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'p2', stripe_payout_id: 'po_2', stripe_account_id: 'acct_2', agent_id: AGENT_2, amount_minor: 5000, currency: 'eur', status: 'failed', arrival_date: null, failure_code: 'account_closed', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
]

let lastEqCalls: [string, unknown][] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      if (table !== 'stripe_connect_payouts') throw new Error(`unexpected table ${table}`)
      const filters: [string, unknown][] = []
      const builder: any = {
        select: () => builder,
        eq(field: string, value: unknown) {
          filters.push([field, value])
          lastEqCalls = filters
          return builder
        },
        order: () => builder,
        limit: () => builder,
        then(resolve: (v: unknown) => unknown) {
          const rows = payoutRows.filter((r) => filters.every(([k, v]) => (r as any)[k] === v))
          return resolve({ data: rows, error: null })
        },
      }
      return builder
    },
  }),
}))

beforeEach(() => {
  lastEqCalls = []
})

describe('GET /api/v1/agents/[id]/payouts', () => {
  it('lets an agent see its own payouts, scoped to only its own agent_id', async () => {
    const token = await signToken({ agent_id: AGENT_1, tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_1}/payouts`, { headers: { authorization: `Bearer ${token}` } })
    const response = await agentPayoutsGet(request, { params: { id: AGENT_1 } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].stripe_payout_id).toBe('po_1')
    expect(body.payouts[0].amount_label).toBe('100.00 EUR')
    expect(lastEqCalls).toContainEqual(['agent_id', AGENT_1])
  })

  it('rejects a different agent reading another agent\'s payouts', async () => {
    const token = await signToken({ agent_id: AGENT_2, tier: 1 }, '15m')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_1}/payouts`, { headers: { authorization: `Bearer ${token}` } })
    const response = await agentPayoutsGet(request, { params: { id: AGENT_1 } })

    expect(response.status).toBe(403)
  })

  it('rejects a buyer token', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: 'x', org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_1}/payouts`, { headers: { authorization: `Bearer ${buyerToken}` } })
    const response = await agentPayoutsGet(request, { params: { id: AGENT_1 } })

    expect(response.status).toBe(403)
  })

  it('rejects an unauthenticated request', async () => {
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_1}/payouts`)
    const response = await agentPayoutsGet(request, { params: { id: AGENT_1 } })

    expect(response.status).toBe(401)
  })

  it('lets an admin token view any agent\'s payouts', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_2}/payouts`, { headers: { authorization: `Bearer ${adminToken}` } })
    const response = await agentPayoutsGet(request, { params: { id: AGENT_2 } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].stripe_payout_id).toBe('po_2')
  })
})

describe('GET /api/v1/admin/payouts', () => {
  it('requires an admin token', async () => {
    const token = await signToken({ agent_id: AGENT_1, tier: 1 }, '15m')
    const request = new NextRequest('http://localhost/api/v1/admin/payouts', { headers: { authorization: `Bearer ${token}` } })
    const response = await adminPayoutsGet(request)

    expect(response.status).toBe(403)
  })

  it('rejects a buyer token', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: 'x', org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/admin/payouts', { headers: { authorization: `Bearer ${buyerToken}` } })
    const response = await adminPayoutsGet(request)

    expect(response.status).toBe(403)
  })

  it('returns every payout across every agent for an admin with no filter', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest('http://localhost/api/v1/admin/payouts', { headers: { authorization: `Bearer ${adminToken}` } })
    const response = await adminPayoutsGet(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.payouts).toHaveLength(2)
    expect(body.payouts.map((p: any) => p.amount_label).sort()).toEqual(['100.00 EUR', '50.00 EUR'].sort())
  })

  it('filters to only failed payouts when status=failed', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest('http://localhost/api/v1/admin/payouts?status=failed', { headers: { authorization: `Bearer ${adminToken}` } })
    const response = await adminPayoutsGet(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].status).toBe('failed')
  })

  it('ignores an invalid status filter value rather than erroring or silently returning nothing', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const request = new NextRequest('http://localhost/api/v1/admin/payouts?status=not-a-real-status', { headers: { authorization: `Bearer ${adminToken}` } })
    const response = await adminPayoutsGet(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.payouts).toHaveLength(2)
  })
})
