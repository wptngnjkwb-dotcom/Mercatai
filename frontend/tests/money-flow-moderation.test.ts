import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-money-flow-moderation-32ch'

const TASK_ID = 'task-money-flow-1'
const BID_ID = 'bid-1'

let taskModerationStatus = 'approved'
const taskUpdates: Record<string, unknown>[] = []

const bidRow = { id: BID_ID, task_id: TASK_ID, agent_id: 'agent-1', price_eur: 50, delivery_hours: 24, status: 'pending' }

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        maybeSingle: async () => {
          if (table === 'transactions') return { data: null, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'bids') return { data: bidRow, error: null }
          if (table === 'tasks') {
            return {
              data: {
                id: TASK_ID,
                status: 'assigned',
                assigned_agent_id: 'agent-1',
                posted_by_org_id: 'org-1',
                moderation_status: taskModerationStatus,
                agents: { id: 'agent-1', stripe_account_id: 'acct_1', stripe_onboarding_completed: true, free_tasks_remaining: 0 },
              },
              error: null,
            }
          }
          return { data: null, error: null }
        },
        update: (values: Record<string, unknown>) => {
          if (table === 'tasks') taskUpdates.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))
vi.mock('@/lib/server/fees', () => ({ calculateFees: vi.fn(() => ({ stripe_fee_eur: 1, platform_fee_eur: 2.5, agent_payout_eur: 46.5 })) }))
vi.mock('@/lib/server/settings', () => ({ getPlatformFeePercent: vi.fn(async () => 5) }))
vi.mock('@/lib/server/paymentState', () => ({ reconcilePaymentIntent: vi.fn(async () => 'requires_action') }))

beforeEach(() => {
  taskModerationStatus = 'approved'
  taskUpdates.length = 0
})

describe('PUT /api/v1/bids/[id]/accept — moderation guard', () => {
  it('blocks accepting a bid once the task has been quarantined', async () => {
    taskModerationStatus = 'quarantined'
    const { PUT } = await import('@/app/api/v1/bids/[id]/accept/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/bids/${BID_ID}/accept`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    const response = await PUT(request, { params: { id: BID_ID } })

    expect(response.status).toBe(409)
    expect(taskUpdates).toHaveLength(0)
  })

  it('allows accepting a bid on an approved task', async () => {
    const { PUT } = await import('@/app/api/v1/bids/[id]/accept/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest(`http://localhost/api/v1/bids/${BID_ID}/accept`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${buyerToken}` },
    })
    const response = await PUT(request, { params: { id: BID_ID } })

    expect(response.status).toBe(200)
    expect(taskUpdates.length).toBeGreaterThan(0)
  })
})

describe('POST /api/v1/payments/create-intent — moderation guard', () => {
  it('refuses to fund a task that is not currently approved', async () => {
    taskModerationStatus = 'quarantined'
    const { POST } = await import('@/app/api/v1/payments/create-intent/route')
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const request = new NextRequest('http://localhost/api/v1/payments/create-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({ task_id: TASK_ID }),
    })
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toMatch(/pending review/i)
  })
})
