import { beforeEach, describe, expect, it, vi } from 'vitest'

let proposal = 'A safe, concise delivery plan.'
const insertedBids: Record<string, unknown>[] = []

const { getLiveAgentPaymentSetup, dispatchOpportunityAlerts } = vi.hoisted(() => ({
  getLiveAgentPaymentSetup: vi.fn(async () => ({ ready: true })),
  dispatchOpportunityAlerts: vi.fn(async () => ({ sent: 0 })),
}))

vi.mock('@/lib/server/agentPaymentSetup', () => ({ getLiveAgentPaymentSetup }))
vi.mock('@/lib/server/opportunityAlerts', () => ({ dispatchOpportunityAlerts }))
vi.mock('@/lib/server/webhookSecurity', () => ({ validateWebhookUrl: vi.fn(async () => ({ ok: true })) }))

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      let headCount = false
      const builder: Record<string, any> = {
        select: (_columns?: string, options?: { head?: boolean }) => {
          headCount = options?.head === true
          return builder
        },
        eq: () => builder,
        or: () => builder,
        in: () => builder,
        gte: () => builder,
        update: () => builder,
        insert: (rows: Record<string, unknown>[]) => {
          if (table === 'bids') insertedBids.push(...rows)
          return Promise.resolve({ error: null })
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'auto_bid_rules') {
            return resolve({
              data: [{
                id: 'rule-1', agent_id: 'agent-1', category: null,
                capabilities: [], min_budget_eur: null, max_price_eur: 50,
                price_strategy: 'min', delivery_hours: 12,
                proposal, sample_preview: null, is_active: true,
                max_bids_per_day: 20,
              }],
              error: null,
            })
          }
          if (table === 'agents') {
            return resolve({
              data: [{ id: 'agent-1', reputation_score: 50, is_active: true, webhook_url: null, webhook_secret: null }],
              error: null,
            })
          }
          if (table === 'bids' && headCount) return resolve({ count: 0, error: null })
          if (table === 'bids') return resolve({ data: [], error: null })
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }),
}))

const task = {
  id: 'task-1',
  title: 'Research task',
  category: 'research',
  required_capabilities: [],
  required_languages: ['en'],
  budget_min_eur: 10,
  budget_max_eur: 50,
  deadline_hours: 24,
  stripe_account_requirement: 'standard_agent_liability' as const,
}

beforeEach(() => {
  proposal = 'A safe, concise delivery plan.'
  insertedBids.length = 0
  getLiveAgentPaymentSetup.mockClear()
  dispatchOpportunityAlerts.mockClear()
})

describe('auto-bid contact policy', () => {
  it('places a safe auto-bid normally', async () => {
    const { runAutoBids } = await import('@/lib/server/autobid')
    await expect(runAutoBids(task)).resolves.toMatchObject({ bids_placed: 1 })
    expect(insertedBids).toHaveLength(1)
  })

  it('skips a legacy rule with off-platform contact coordinates', async () => {
    proposal = 'Continue on Telegram @outside_agent'
    const { runAutoBids } = await import('@/lib/server/autobid')
    await expect(runAutoBids(task)).resolves.toEqual({ bids_placed: 0, agents_notified: 0 })
    expect(insertedBids).toHaveLength(0)
    expect(dispatchOpportunityAlerts).toHaveBeenCalledTimes(1)
  })
})
