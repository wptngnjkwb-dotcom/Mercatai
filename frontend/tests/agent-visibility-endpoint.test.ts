import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-agent-visibility-32ch'

const OWN_AGENT_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_AGENT_ID = '22222222-2222-2222-2222-222222222222'

const agentRow = { id: OWN_AGENT_ID, profile_visibility: 'public' }
const agentUpdates: Record<string, unknown>[] = []
const auditedActions: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        update: (values: Record<string, unknown>) => {
          if (table === 'agents') {
            agentUpdates.push(values)
            Object.assign(agentRow, values)
          }
          return builder
        },
        single: async () => (table === 'agents' ? { data: { ...agentRow }, error: null } : { data: null, error: null }),
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async (entry: Record<string, unknown>) => { auditedActions.push(entry) }) }))

beforeEach(() => {
  agentRow.profile_visibility = 'public'
  agentUpdates.length = 0
  auditedActions.length = 0
})

function patchRequest(bearer: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/visibility`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/v1/agents/[id]/visibility', () => {
  it('lets the agent switch its own profile to private', async () => {
    const { PATCH } = await import('@/app/api/v1/agents/[id]/visibility/route')
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await PATCH(patchRequest(token, { profile_visibility: 'private' }), { params: { id: OWN_AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.profile_visibility).toBe('private')
    expect(agentUpdates).toContainEqual({ profile_visibility: 'private' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Vary')).toBe('Authorization')
  })

  it('lets an admin switch a different agent\'s profile', async () => {
    const { PATCH } = await import('@/app/api/v1/agents/[id]/visibility/route')
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const response = await PATCH(patchRequest(adminToken, { profile_visibility: 'private' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(200)
    expect(agentUpdates).toContainEqual({ profile_visibility: 'private' })
  })

  it('rejects a different agent\'s token with 403 — does not write anything', async () => {
    const { PATCH } = await import('@/app/api/v1/agents/[id]/visibility/route')
    const otherToken = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const response = await PATCH(patchRequest(otherToken, { profile_visibility: 'private' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(403)
    expect(agentUpdates).toHaveLength(0)
  })

  it('rejects a missing/invalid token with 401', async () => {
    const { PATCH } = await import('@/app/api/v1/agents/[id]/visibility/route')
    const request = new NextRequest(`http://localhost/api/v1/agents/${OWN_AGENT_ID}/visibility`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_visibility: 'private' }),
    })
    const response = await PATCH(request, { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(401)
    expect(agentUpdates).toHaveLength(0)
  })

  it('rejects an invalid profile_visibility value with 400', async () => {
    const { PATCH } = await import('@/app/api/v1/agents/[id]/visibility/route')
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    const response = await PATCH(patchRequest(token, { profile_visibility: 'hidden' }), { params: { id: OWN_AGENT_ID } })

    expect(response.status).toBe(400)
    expect(agentUpdates).toHaveLength(0)
  })

  it('does not write an audit entry with personal data — just the state transition', async () => {
    const { PATCH } = await import('@/app/api/v1/agents/[id]/visibility/route')
    const token = await signToken({ agent_id: OWN_AGENT_ID, tier: 1 }, '15m')
    await PATCH(patchRequest(token, { profile_visibility: 'private' }), { params: { id: OWN_AGENT_ID } })

    expect(auditedActions).toHaveLength(1)
    const details = JSON.stringify(auditedActions[0])
    expect(details).not.toMatch(/email|owner|@/i)
  })
})
