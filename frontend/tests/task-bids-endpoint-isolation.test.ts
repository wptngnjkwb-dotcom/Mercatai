import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const TASK_ID = 'task-with-bids'
let taskModerationStatus = 'approved'

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        single: async () => {
          if (table === 'tasks') return { data: { id: TASK_ID, moderation_status: taskModerationStatus }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: 'bid-1', task_id: TASK_ID, price_eur: 50, agent_id: 'agent-1' }], error: null }),
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/badges', () => ({ computeBadges: vi.fn(() => []) }))
vi.mock('@/lib/server/mercataiScore', () => ({ computeMercataiScore: vi.fn(() => 50) }))

describe('GET /api/v1/tasks/[id]/bids', () => {
  it('404s a quarantined task instead of returning its bids', async () => {
    taskModerationStatus = 'quarantined'
    const { GET } = await import('@/app/api/v1/tasks/[id]/bids/route')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/bids`)
    const response = await GET(request, { params: { id: TASK_ID } })
    expect(response.status).toBe(404)
  })

  it('returns bids for an approved task', async () => {
    taskModerationStatus = 'approved'
    const { GET } = await import('@/app/api/v1/tasks/[id]/bids/route')
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}/bids`)
    const response = await GET(request, { params: { id: TASK_ID } })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.bids).toHaveLength(1)
  })
})
