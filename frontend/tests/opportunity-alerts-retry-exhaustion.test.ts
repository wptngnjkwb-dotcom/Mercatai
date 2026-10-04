import { describe, expect, it, vi, beforeEach } from 'vitest'

// A delivery that exhausts every retry attempt must not keep its frozen
// payload (which embeds the agent operator's email) around forever —
// Privacy Policy §4 says the snapshot is "retained only while pending or
// retrying", so once retryOpportunityAlertDeliveries will never select the
// row again, the snapshot must be cleared in the same update that marks it
// permanently failed.

const FROZEN_PAYLOAD = {
  from: 'Mercatai <noreply@mercatai.eu>',
  to: 'operator@example.com',
  subject: 'New Mercatai task open for bids: Task',
  html: '<p>...</p>',
  payloadVersion: 1,
}

let claimResult: { data: any; error: any }
let subscriptionRow: { is_active: boolean; agent_id: string } | null
let agentRow: { is_active: boolean } | null
let lastDeliveriesUpdate: Record<string, unknown> | null
let retryRows: any[]
let queryFilters: Array<{ method: string; args: unknown[] }>

vi.mock('@/lib/server/email', () => ({
  sendOpportunityAlertOrThrow: vi.fn(async () => {
    throw new Error('Resend rejected the opportunity alert: simulated failure')
  }),
  buildOpportunityAlertProviderPayload: vi.fn(),
}))

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    rpc: async () => claimResult,
    from: (table: string) => {
      let operation: 'select' | 'update' | null = null
      const builder: any = {
        select: () => { operation = 'select'; return builder },
        eq: (...args: unknown[]) => { queryFilters.push({ method: 'eq', args }); return builder },
        lt: (...args: unknown[]) => { queryFilters.push({ method: 'lt', args }); return builder },
        gte: (...args: unknown[]) => { queryFilters.push({ method: 'gte', args }); return builder },
        not: (...args: unknown[]) => { queryFilters.push({ method: 'not', args }); return builder },
        or: (...args: unknown[]) => { queryFilters.push({ method: 'or', args }); return builder },
        order: () => builder,
        limit: () => builder,
        update: (payload: Record<string, unknown>) => {
          operation = 'update'
          if (table === 'opportunity_alert_deliveries') lastDeliveriesUpdate = payload
          return builder
        },
        maybeSingle: async () => {
          if (table === 'opportunity_alert_subscriptions') return { data: subscriptionRow, error: null }
          if (table === 'agents') return { data: agentRow, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({
          data: operation === 'select' ? retryRows : null,
          error: null,
        }),
      }
      return builder
    },
  }),
}))

import { processOpportunityAlertDelivery } from '@/lib/server/opportunityAlerts'
import { getSupabase } from '@/lib/server/supabase'

beforeEach(() => {
  subscriptionRow = { is_active: true, agent_id: 'agent-1' }
  agentRow = { is_active: true }
  lastDeliveriesUpdate = null
  retryRows = []
  queryFilters = []
})

describe('retryOpportunityAlertDeliveries — hard retention boundary', () => {
  it('expires frozen payloads after seven days before selecting retryable rows', async () => {
    const { retryOpportunityAlertDeliveries, MAX_DELIVERY_AGE_DAYS } = await import('@/lib/server/opportunityAlerts')
    const result = await retryOpportunityAlertDeliveries()
    expect(MAX_DELIVERY_AGE_DAYS).toBe(7)
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0 })
    expect(lastDeliveriesUpdate).toMatchObject({
      status: 'failed',
      payload_snapshot: null,
      claim_token: null,
      claimed_at: null,
    })
    expect(queryFilters).toContainEqual({ method: 'not', args: ['payload_snapshot', 'is', null] })
    expect(queryFilters.some((filter) => filter.method === 'lt' && filter.args[0] === 'created_at')).toBe(true)
    expect(queryFilters.some((filter) => filter.method === 'gte' && filter.args[0] === 'created_at')).toBe(true)
  })
})

describe('processOpportunityAlertDelivery — retry exhaustion clears the frozen payload', () => {
  it('clears payload_snapshot when the failing attempt was the last allowed one', async () => {
    claimResult = {
      data: [{
        delivery_id: 'delivery-1', subscription_id: 'sub-1', task_id: 'task-1',
        payload_snapshot: FROZEN_PAYLOAD, claim_token: 'tok-1', attempt_count: 20,
      }],
      error: null,
    }
    const result = await processOpportunityAlertDelivery(getSupabase(), 'delivery-1')
    expect(result).toBe('failed')
    expect(lastDeliveriesUpdate).toMatchObject({ status: 'failed', payload_snapshot: null })
  })

  it('keeps payload_snapshot when retries remain, so the cron can still send it', async () => {
    claimResult = {
      data: [{
        delivery_id: 'delivery-1', subscription_id: 'sub-1', task_id: 'task-1',
        payload_snapshot: FROZEN_PAYLOAD, claim_token: 'tok-1', attempt_count: 3,
      }],
      error: null,
    }
    const result = await processOpportunityAlertDelivery(getSupabase(), 'delivery-1')
    expect(result).toBe('failed')
    expect(lastDeliveriesUpdate).toMatchObject({ status: 'failed' })
    expect(lastDeliveriesUpdate).not.toHaveProperty('payload_snapshot')
  })
})
