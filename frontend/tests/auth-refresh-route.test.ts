import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { POST } from '@/app/api/v1/auth/refresh/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-refresh-route-32-characters'

const AGENT_ID = '22222222-2222-2222-2222-222222222222'

let agentRow: Record<string, unknown> | null = null

// A single generic thenable builder — every chain used by the route (and by
// the rate-limit/audit helpers it calls internally) resolves off it, keyed
// only on which table .single()/.maybeSingle() is reading from.
vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        insert: () => builder,
        update: () => builder,
        eq: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => (table === 'agents' ? { data: agentRow, error: agentRow ? null : { message: 'not found' } } : { data: null, error: null }),
        maybeSingle: async () => (table === 'agents' ? { data: agentRow, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null }),
      }
      return builder
    },
  }),
}))

function refreshRequest(body: unknown) {
  return new NextRequest('http://localhost/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/v1/auth/refresh', () => {
  beforeEach(() => {
    agentRow = { id: AGENT_ID, agent_id: 'refresh-test-agent', tier: 1, is_active: true }
  })

  it('issues a new access token for a valid refresh token', async () => {
    const refreshToken = await signToken({ agent_id: AGENT_ID, type: 'refresh' }, '7d')
    const response = await POST(refreshRequest({ refresh_token: refreshToken }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(typeof body.access_token).toBe('string')
    expect(body.expires_in).toBe(900)
  })

  it('rejects a missing refresh_token', async () => {
    const response = await POST(refreshRequest({}))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('missing_token')
  })

  it('rejects an expired refresh token', async () => {
    const expired = await signToken({ agent_id: AGENT_ID, type: 'refresh' }, Math.floor(Date.now() / 1000) - 10)
    const response = await POST(refreshRequest({ refresh_token: expired }))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.code).toBe('token_expired')
  })

  it('rejects an access token presented as a refresh token', async () => {
    // Same mistake in reverse — an access token has no type:'refresh' claim.
    const accessToken = await signToken({ agent_id: AGENT_ID, agent_slug: 'refresh-test-agent', tier: 1 }, '15m')
    const response = await POST(refreshRequest({ refresh_token: accessToken }))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.code).toBe('invalid_token')
  })

  it('rejects a refresh token whose agent has since been deactivated', async () => {
    agentRow = { id: AGENT_ID, agent_id: 'refresh-test-agent', tier: 1, is_active: false }
    const refreshToken = await signToken({ agent_id: AGENT_ID, type: 'refresh' }, '7d')
    const response = await POST(refreshRequest({ refresh_token: refreshToken }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('Agent is inactive')
  })

  it('rejects a refresh token for an agent that no longer exists', async () => {
    agentRow = null
    const refreshToken = await signToken({ agent_id: AGENT_ID, type: 'refresh' }, '7d')
    const response = await POST(refreshRequest({ refresh_token: refreshToken }))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.code).toBe('invalid_token')
  })
})
