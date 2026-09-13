import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-task-bids-isolation-32ch'

const TASK_ID = 'task-with-bids'
const OTHER_TASK_ID = 'task-other'
const PUBLIC_AGENT_ID = 'agent-public-1'
const PRIVATE_AGENT_ID = 'agent-private-1'
let taskModerationStatus = 'approved'
let taskArchivedAt: string | null = null

const bidRows = [
  { id: 'bid-public', task_id: TASK_ID, price_eur: 50, agent_id: PUBLIC_AGENT_ID, delivery_hours: 24, approach_summary: 'plan A', sample_preview: null, score: 0.9, status: 'pending', submitted_at: '2026-08-01T00:00:00Z', agents: { id: PUBLIC_AGENT_ID, display_name: 'Public Agent', reputation_score: 60, tier: 2, success_rate: 0.9, total_tasks_completed: 10, verification_level: 'anonymous', stripe_onboarding_completed: true, profile_visibility: 'public' } },
  { id: 'bid-private', task_id: TASK_ID, price_eur: 60, agent_id: PRIVATE_AGENT_ID, delivery_hours: 12, approach_summary: 'plan B', sample_preview: null, score: 0.8, status: 'pending', submitted_at: '2026-08-01T01:00:00Z', agents: { id: PRIVATE_AGENT_ID, display_name: 'Private Agent', reputation_score: 70, tier: 3, success_rate: 0.95, total_tasks_completed: 20, verification_level: 'anonymous', stripe_onboarding_completed: true, profile_visibility: 'private' } },
]

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        single: async () => {
          if (table === 'tasks') return { data: { id: TASK_ID, moderation_status: taskModerationStatus, archived_at: taskArchivedAt }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'bids') return resolve({ data: bidRows, error: null })
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/badges', () => ({ computeBadges: vi.fn(() => []) }))
vi.mock('@/lib/server/mercataiScore', () => ({ computeMercataiScore: vi.fn(() => 50) }))

async function fetchBids(bearer?: string) {
  const { GET } = await import('@/app/api/v1/tasks/[id]/bids/route')
  const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/bids`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
  return GET(request, { params: { id: TASK_ID } })
}

describe('GET /api/v1/tasks/[id]/bids', () => {
  it('404s a quarantined task instead of returning its bids', async () => {
    taskModerationStatus = 'quarantined'
    try {
      const response = await fetchBids()
      expect(response.status).toBe(404)
    } finally {
      taskModerationStatus = 'approved'
    }
  })

  it('sets Cache-Control: private, no-store and Vary: Authorization — the response depends on who is asking', async () => {
    const response = await fetchBids()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Vary')).toBe('Authorization')
  })

  it('returns the public agent\'s bid to an anonymous caller, unchanged from before this feature', async () => {
    const response = await fetchBids()
    const body = await response.json()
    expect(response.status).toBe(200)
    const publicBid = body.bids.find((b: any) => b.id === 'bid-public')
    expect(publicBid).toMatchObject({
      id: 'bid-public',
      agent_id: PUBLIC_AGENT_ID,
      agent_is_private: false,
      agent_display_name: 'Public Agent',
      price_eur: 50,
    })
  })

  it('excludes the private agent\'s bid — no bid object, no id, no agent_id — for an anonymous caller', async () => {
    const response = await fetchBids()
    const body = await response.json()
    expect(body.bids).toHaveLength(1)
    expect(body.bids.find((b: any) => b.id === 'bid-private')).toBeUndefined()
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(PRIVATE_AGENT_ID)
    expect(serialized).not.toContain('Private Agent')
  })

  it('excludes the private agent\'s bid for a different agent\'s own token too', async () => {
    const otherAgentToken = await signToken({ agent_id: 'some-other-agent', tier: 1 }, '15m')
    const response = await fetchBids(otherAgentToken)
    const body = await response.json()
    expect(body.bids.find((b: any) => b.id === 'bid-private')).toBeUndefined()
  })

  it('shows the private agent\'s bid, with pseudonymous display name/price/reputation, to this task\'s own buyer', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-1' }, '30d')
    const response = await fetchBids(buyerToken)
    const body = await response.json()
    const privateBid = body.bids.find((b: any) => b.id === 'bid-private')
    expect(privateBid).toMatchObject({
      agent_id: null,
      agent_is_private: true,
      agent_display_name: 'Private Agent',
      price_eur: 60,
      delivery_hours: 12,
      approach_summary: 'plan B',
      agent_reputation_score: 70,
      agent_tier: 3,
    })
    expect(JSON.stringify(privateBid)).not.toContain(PRIVATE_AGENT_ID)
    expect(body.bids).toHaveLength(2)
  })

  it('does not show the private agent\'s bid to a buyer token bound to a different task', async () => {
    const otherBuyerToken = await signToken({ role: 'buyer', task_id: OTHER_TASK_ID, org_id: 'org-1' }, '30d')
    const response = await fetchBids(otherBuyerToken)
    const body = await response.json()
    expect(body.bids.find((b: any) => b.id === 'bid-private')).toBeUndefined()
  })

  it('lets the private agent see its own bid', async () => {
    const ownToken = await signToken({ agent_id: PRIVATE_AGENT_ID, tier: 3 }, '15m')
    const response = await fetchBids(ownToken)
    const body = await response.json()
    expect(body.bids.find((b: any) => b.id === 'bid-private')).toBeDefined()
  })

  it('lets an admin see every bid, including the private agent\'s', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await fetchBids(adminToken)
    const body = await response.json()
    expect(body.bids).toHaveLength(2)
  })

  it('404s an archived task\'s bids for a caller with no admin token', async () => {
    taskArchivedAt = '2026-01-01T00:00:00.000Z'
    try {
      const response = await fetchBids()
      expect(response.status).toBe(404)
    } finally {
      taskArchivedAt = null
    }
  })

  it('404s an archived task\'s bids for a non-admin agent token too', async () => {
    taskArchivedAt = '2026-01-01T00:00:00.000Z'
    try {
      const agentToken = await signToken({ agent_id: 'some-other-agent', tier: 1 }, '15m')
      const response = await fetchBids(agentToken)
      expect(response.status).toBe(404)
    } finally {
      taskArchivedAt = null
    }
  })

  it('lets an admin see bids on an archived task — demo/archived bid history stays admin-discoverable', async () => {
    taskArchivedAt = '2026-01-01T00:00:00.000Z'
    try {
      const adminToken = await signToken({ tier: 'admin' }, '12h')
      const response = await fetchBids(adminToken)
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.bids).toHaveLength(2)
    } finally {
      taskArchivedAt = null
    }
  })
})
