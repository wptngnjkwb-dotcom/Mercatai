import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-agent-profile-subresources-32ch'

// Covers GET /api/v1/agents/{id}/reputation, /reviews, /portfolio — none had
// any test coverage before this feature, and none had an agent-existence
// check at all before now (reviews/portfolio just returned an empty list
// for any id, private or nonexistent).

const AGENT_ID = 'agent-sub-1'
let agentRow: { id: string; agent_id: string; display_name: string; reputation_score: number; tier: number; success_rate: number; total_tasks_completed: number; is_active: boolean; created_at: string; profile_visibility: string } | null

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => {
          if (table === 'agents') return agentRow ? { data: agentRow, error: null } : { data: null, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/affiliate', () => ({ resolveApiClient: vi.fn(async () => null) }))

beforeEach(() => {
  agentRow = {
    id: AGENT_ID,
    agent_id: AGENT_ID,
    display_name: 'Sub Agent',
    reputation_score: 60,
    tier: 2,
    success_rate: 0.8,
    total_tasks_completed: 5,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    profile_visibility: 'public',
  }
})

function anon(path: string) {
  return new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/${path}`)
}
async function withToken(path: string, bearer: string) {
  return new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/${path}`, { headers: { authorization: `Bearer ${bearer}` } })
}

describe('GET /api/v1/agents/[id]/reputation — visibility', () => {
  it('is public for a public agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/reputation/route')
    const response = await GET(anon('reputation'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('404s for an anonymous caller when the agent is private', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/reputation/route')
    const response = await GET(anon('reputation'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(404)
  })

  it('is visible to the agent itself, with private, no-store caching', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/reputation/route')
    const token = await signToken({ agent_id: AGENT_ID, tier: 2 }, '15m')
    const response = await GET(await withToken('reputation', token), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('is visible to an admin', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/reputation/route')
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await GET(await withToken('reputation', adminToken), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
  })

  it('a developer mct_ API key does not unlock a private profile', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/reputation/route')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/reputation`, {
      headers: { authorization: 'Bearer mct_some_developer_key' },
    })
    const response = await GET(request, { params: { id: AGENT_ID } })
    expect(response.status).toBe(404)
  })
})

describe('GET /api/v1/agents/[id]/reviews — visibility', () => {
  it('is public for a public agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/reviews/route')
    const response = await GET(anon('reviews'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
  })

  it('404s for an anonymous caller when the agent is private (previously: always 200 with an empty list, no existence check at all)', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/reviews/route')
    const response = await GET(anon('reviews'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(404)
  })

  it('is visible to the agent itself', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/reviews/route')
    const token = await signToken({ agent_id: AGENT_ID, tier: 2 }, '15m')
    const response = await GET(await withToken('reviews', token), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('404s for a nonexistent agent', async () => {
    agentRow = null
    const { GET } = await import('@/app/api/v1/agents/[id]/reviews/route')
    const response = await GET(anon('reviews'), { params: { id: 'does-not-exist' } })
    expect(response.status).toBe(404)
  })
})

describe('GET /api/v1/agents/[id]/portfolio — visibility', () => {
  it('is public for a public agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/portfolio/route')
    const response = await GET(anon('portfolio'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
  })

  it('404s for an anonymous caller when the agent is private', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/portfolio/route')
    const response = await GET(anon('portfolio'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(404)
  })

  it('is visible to an admin', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/portfolio/route')
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await GET(await withToken('portfolio', adminToken), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
  })
})
