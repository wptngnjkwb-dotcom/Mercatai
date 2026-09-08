import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Covers every public listing surface a private agent must be excluded
// from: GET /api/v1/agents, GET /api/v1/agents/recommend, GET /api/v1/store.
// None of these had test coverage before this feature.

const PUBLIC_AGENT = { id: 'agent-pub', agent_id: 'agent-pub', display_name: 'Public Agent', description: '', capabilities: [], languages: [], reputation_score: 50, tier: 1, success_rate: 0, total_tasks_completed: 0, is_active: true, verification_level: 'anonymous', stripe_onboarding_completed: true, profile_visibility: 'public' }
const PRIVATE_AGENT = { id: 'agent-priv', agent_id: 'agent-priv', display_name: 'Private Agent', description: '', capabilities: [], languages: [], reputation_score: 50, tier: 1, success_rate: 0, total_tasks_completed: 0, is_active: true, verification_level: 'anonymous', stripe_onboarding_completed: true, profile_visibility: 'private' }

// Each mocked query filters agentsTable in-memory by every .eq() applied,
// so a route that forgets to filter on profile_visibility would actually
// get the private agent back here — this is a real filter, not a stub that
// always returns the "correct" answer regardless of the route's query.
function makeAgentsBuilder(rows: Record<string, any>[], eqFilters: [string, unknown][] = []) {
  const builder: Record<string, any> = {
    select: () => builder,
    eq: (field: string, value: unknown) => makeAgentsBuilder(rows, [...eqFilters, [field, value]]),
    contains: () => builder,
    overlaps: () => builder,
    limit: () => builder,
    order: () => builder,
    then: (resolve: (v: unknown) => unknown) => {
      const filtered = rows.filter((r) => eqFilters.every(([f, v]) => r[f] === v))
      return resolve({ data: filtered, error: null })
    },
  }
  return builder
}

// Same accumulate-then-filter-once shape as makeAgentsBuilder — a naive
// mock where each .eq() call replaces (rather than composes with) the
// previous filter's `then` silently drops earlier filters the moment
// .order()/.limit() falls back to an unfiltered base object. Handles both
// plain columns (is_active) and the embedded-relation dotted form
// (agents.profile_visibility) the real route filters on.
function makeListingsBuilder(rows: Record<string, any>[], eqFilters: [string, unknown][] = []) {
  const builder: Record<string, any> = {
    select: () => builder,
    eq: (field: string, value: unknown) => makeListingsBuilder(rows, [...eqFilters, [field, value]]),
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => unknown) => {
      const filtered = rows.filter((r) =>
        eqFilters.every(([f, v]) => {
          if (f.startsWith('agents.')) return r.agents[f.slice('agents.'.length)] === v
          return r[f] === v
        })
      )
      return resolve({ data: filtered, error: null })
    },
  }
  return builder
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      if (table === 'agents') return makeAgentsBuilder([PUBLIC_AGENT, PRIVATE_AGENT])
      if (table === 'reviews') {
        return {
          select: () => ({ in: () => ({ then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }) }) }),
        }
      }
      if (table === 'tasks') {
        return {
          select: () => ({
            eq: () => ({ in: () => ({ limit: () => ({ then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }) }) }) }),
          }),
        }
      }
      if (table === 'agent_listings') {
        const listings = [
          { id: 'listing-pub', title: 'Public listing', description: '', category: null, price_eur: 10, delivery_hours: 24, hires_count: 0, created_at: '2026-01-01', is_active: true, agents: PUBLIC_AGENT },
          { id: 'listing-priv', title: 'Private listing', description: '', category: null, price_eur: 10, delivery_hours: 24, hires_count: 0, created_at: '2026-01-01', is_active: true, agents: PRIVATE_AGENT },
        ]
        return makeListingsBuilder(listings)
      }
      return { select: () => ({ then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }) }) }
    },
  }),
}))
vi.mock('@/lib/server/mercataiScore', () => ({ computeMercataiScore: vi.fn(() => ({ score: 50, grade: 'B', label: 'Good', components: [] })) }))

// GET /api/v1/agents itself is NOT covered here — that route file
// (app/api/v1/agents/route.ts) is already owned by
// agent-registration-org-identity.test.ts (its POST handler), and
// isolate:false means a second file mocking the same route's dependencies
// would corrupt whichever one evaluates the module first. See the
// "profile_visibility" describe block there for that coverage instead.

describe('GET /api/v1/agents/recommend — excludes private agents', () => {
  it('never recommends the private agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/recommend/route')
    const request = new NextRequest('http://localhost/api/v1/agents/recommend')
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.recommendations.some((a: any) => a.id === PRIVATE_AGENT.id)).toBe(false)
  })
})

describe('GET /api/v1/store — excludes private agents\' listings', () => {
  it('never returns the private agent\'s listing', async () => {
    const { GET } = await import('@/app/api/v1/store/route')
    const request = new NextRequest('http://localhost/api/v1/store')
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.listings.some((l: any) => l.id === 'listing-priv')).toBe(false)
    expect(body.listings.some((l: any) => l.id === 'listing-pub')).toBe(true)
  })
})
