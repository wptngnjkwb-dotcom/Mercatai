import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { sendRecovery, auditLog, insertedTokens, tokenUpdates, rpcConsume } = vi.hoisted(() => ({
  sendRecovery: vi.fn(),
  auditLog: vi.fn(async () => {}),
  insertedTokens: [] as Record<string, unknown>[],
  tokenUpdates: [] as Record<string, unknown>[],
  rpcConsume: vi.fn(),
}))

let agentRow: Record<string, unknown> | null

vi.mock('@/lib/server/rateLimit', () => ({
  clientIp: vi.fn(() => '203.0.113.10'),
  isRateLimited: vi.fn(async () => false),
  recordAttempt: vi.fn(async () => {}),
}))
vi.mock('@/lib/server/audit', () => ({ auditLog }))
vi.mock('@/lib/server/email', () => ({ sendAgentApiKeyRecoveryOrThrow: sendRecovery }))
vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    rpc: rpcConsume,
    from(table: string) {
      let inserted: Record<string, unknown> | null = null
      const builder: any = {
        select() { return builder },
        eq() { return builder },
        insert(values: Record<string, unknown>) { inserted = values; if (table === 'agent_api_key_recovery_tokens') insertedTokens.push(values); return builder },
        update(values: Record<string, unknown>) { if (table === 'agent_api_key_recovery_tokens') tokenUpdates.push(values); return builder },
        async maybeSingle() { return table === 'agents' ? { data: agentRow, error: null } : { data: null, error: null } },
        async single() { return table === 'agent_api_key_recovery_tokens' && inserted ? { data: { id: 'recovery-1' }, error: null } : { data: null, error: null } },
        then(resolve: (value: unknown) => unknown) { return resolve({ data: null, error: null }) },
      }
      return builder
    },
  }),
}))

import { POST as requestRecovery } from '@/app/api/v1/auth/agent-key-recovery/route'
import { POST as confirmRecovery } from '@/app/api/v1/auth/agent-key-recovery/confirm/route'

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('agent API-key recovery', () => {
  beforeEach(() => {
    agentRow = { id: 'agent-db-1', agent_id: 'humanmirror-jamenbin', owner_email: 'operator@example.com', is_active: true }
    insertedTokens.length = 0
    tokenUpdates.length = 0
    sendRecovery.mockReset()
    sendRecovery.mockResolvedValue('email-1')
    rpcConsume.mockReset()
    auditLog.mockClear()
  })

  it('returns the same enumeration-safe 202 for a match and mismatch', async () => {
    const matching = await requestRecovery(request('http://localhost/api/v1/auth/agent-key-recovery', { agent_id: 'humanmirror-jamenbin', email: 'operator@example.com' }))
    const matchingBody = await matching.json()
    agentRow = null
    const missing = await requestRecovery(request('http://localhost/api/v1/auth/agent-key-recovery', { agent_id: 'unknown', email: 'operator@example.com' }))
    const missingBody = await missing.json()

    expect(matching.status).toBe(202)
    expect(missing.status).toBe(202)
    expect(missingBody).toEqual(matchingBody)
    expect(insertedTokens).toHaveLength(1)
    expect(insertedTokens[0].token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(insertedTokens[0])).not.toContain('operator@example.com')
  })

  it('invalidates the stored token if the recovery email cannot be delivered', async () => {
    sendRecovery.mockRejectedValueOnce(new Error('provider unavailable'))
    const response = await requestRecovery(request('http://localhost/api/v1/auth/agent-key-recovery', { agent_id: 'humanmirror-jamenbin', email: 'operator@example.com' }))
    expect(response.status).toBe(202)
    expect(tokenUpdates).toHaveLength(1)
    expect(tokenUpdates[0]).toHaveProperty('used_at')
  })

  it('returns a replacement key once after the atomic consume RPC succeeds', async () => {
    rpcConsume.mockResolvedValueOnce({ data: [{ agent_id: 'agent-db-1', agent_slug: 'humanmirror-jamenbin', auth_version: 2 }], error: null })
    const response = await confirmRecovery(request('http://localhost/api/v1/auth/agent-key-recovery/confirm', { token: 'x'.repeat(43) }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.agent_id).toBe('humanmirror-jamenbin')
    expect(body.api_key).toMatch(/^[a-f0-9]{64}$/)
    expect(body.old_key_revoked).toBe(true)
    expect(body.old_refresh_tokens_revoked).toBe(true)
    expect(rpcConsume).toHaveBeenCalledWith('consume_agent_api_key_recovery', expect.objectContaining({
      p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_new_api_key_hash: expect.stringMatching(/^\$2/),
    }))
  })

  it('never returns a key for an expired, used or concurrently consumed token', async () => {
    rpcConsume.mockResolvedValueOnce({ data: [], error: null })
    const response = await confirmRecovery(request('http://localhost/api/v1/auth/agent-key-recovery/confirm', { token: 'x'.repeat(43) }))
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body).not.toHaveProperty('api_key')
  })
})
