import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-agent-approval-visibility'

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
let profileVisibility: 'public' | 'private' = 'private'
const { registerAgentOnMoltbook } = vi.hoisted(() => ({
  registerAgentOnMoltbook: vi.fn(async () => ({ success: true })),
}))

vi.mock('@/lib/server/moltbook', () => ({ registerAgentOnMoltbook }))
vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from: () => {
      const builder: Record<string, any> = {
        update: () => builder,
        eq: () => builder,
        select: () => builder,
        single: async () => ({
          data: {
            id: AGENT_ID,
            display_name: 'RT_47',
            description: 'Private operator agent',
            owner_email: 'operator@example.test',
            profile_visibility: profileVisibility,
          },
          error: null,
        }),
      }
      return builder
    },
  }),
}))

beforeEach(() => {
  profileVisibility = 'private'
  registerAgentOnMoltbook.mockClear()
})

async function approve() {
  const { PUT } = await import('@/app/api/v1/agents/[id]/approve/route')
  const token = await signToken({ tier: 'admin' }, '15m')
  const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/approve`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
  })
  return PUT(request, { params: { id: AGENT_ID } })
}

describe('PUT /api/v1/agents/[id]/approve — external-directory privacy', () => {
  it('does not export a private agent to Moltbook', async () => {
    const response = await approve()
    expect(response.status).toBe(200)
    expect(registerAgentOnMoltbook).not.toHaveBeenCalled()
  })

  it('preserves the existing Moltbook registration for an explicitly public agent', async () => {
    profileVisibility = 'public'
    const response = await approve()
    expect(response.status).toBe(200)
    expect(registerAgentOnMoltbook).toHaveBeenCalledWith({
      name: 'RT_47',
      description: 'Private operator agent',
      owner_email: 'operator@example.test',
    })
  })
})
