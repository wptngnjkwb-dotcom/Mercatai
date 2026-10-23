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
const portfolioInserts: Record<string, unknown>[] = []
const portfolioRows: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      let inserted: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        insert: (values: Record<string, unknown>) => {
          inserted = values
          if (table === 'agent_portfolio') portfolioInserts.push(values)
          return builder
        },
        single: async () => {
          if (table === 'agents') return agentRow ? { data: agentRow, error: null } : { data: null, error: null }
          if (table === 'agent_portfolio' && inserted) return { data: { id: 'portfolio-1', ...inserted }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: table === 'agent_portfolio' ? portfolioRows : [], error: null }),
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/affiliate', () => ({ resolveApiClient: vi.fn(async () => null) }))

beforeEach(() => {
  portfolioInserts.length = 0
  portfolioRows.length = 0
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

  it('blocks contact details in a public portfolio item but permits a private note', async () => {
    const { POST } = await import('@/app/api/v1/agents/[id]/portfolio/route')
    const token = await signToken({ agent_id: AGENT_ID, tier: 2 }, '15m')
    const request = (isPublic: boolean) => new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/portfolio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: 'Research sample',
        description: 'See https://outside.example.com/work',
        is_public: isPublic,
      }),
    })

    const blocked = await POST(request(true), { params: { id: AGENT_ID } })
    expect(blocked.status).toBe(422)
    expect(await blocked.json()).toMatchObject({ code: 'off_platform_contact_not_allowed' })
    expect(portfolioInserts).toHaveLength(0)

    const allowed = await POST(request(false), { params: { id: AGENT_ID } })
    expect(allowed.status).toBe(201)
    expect(portfolioInserts).toHaveLength(1)
  })

  it('hides legacy public portfolio contact details from anonymous callers but lets the owner inspect them', async () => {
    portfolioRows.push(
      { id: 'safe-item', title: 'Safe sample', description: 'A normal work sample', content: null },
      { id: 'unsafe-item', title: 'Contact sample', description: 'Email outside@example.com', content: null },
    )
    const { GET } = await import('@/app/api/v1/agents/[id]/portfolio/route')

    const anonymous = await GET(anon('portfolio'), { params: { id: AGENT_ID } })
    expect((await anonymous.json()).items.map((item: any) => item.id)).toEqual(['safe-item'])

    const token = await signToken({ agent_id: AGENT_ID, tier: 2 }, '15m')
    const owner = await GET(await withToken('portfolio', token), { params: { id: AGENT_ID } })
    expect((await owner.json()).items.map((item: any) => item.id)).toEqual(['safe-item', 'unsafe-item'])
  })
})

describe('GET /api/v1/agents/[id]/verified-stats — visibility', () => {
  it('returns aggregate-only evidence for a public agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/verified-stats/route')
    const response = await GET(anon('verified-stats'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual(expect.objectContaining({
      metrics_scope: 'released_or_refunded_non_demo_transactions',
      paid_tasks_completed: 0,
      outcome_sample_size: 0,
      release_rate: null,
    }))
  })

  it('does not reveal a private agent to an anonymous caller', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/verified-stats/route')
    const response = await GET(anon('verified-stats'), { params: { id: AGENT_ID } })
    expect(response.status).toBe(404)
  })

  it('is visible to the private agent itself', async () => {
    agentRow!.profile_visibility = 'private'
    const { GET } = await import('@/app/api/v1/agents/[id]/verified-stats/route')
    const token = await signToken({ agent_id: AGENT_ID, tier: 2 }, '15m')
    const response = await GET(await withToken('verified-stats', token), { params: { id: AGENT_ID } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('404s for a nonexistent agent', async () => {
    agentRow = null
    const { GET } = await import('@/app/api/v1/agents/[id]/verified-stats/route')
    const response = await GET(anon('verified-stats'), { params: { id: 'does-not-exist' } })
    expect(response.status).toBe(404)
  })
})
