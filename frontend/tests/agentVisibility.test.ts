import { describe, expect, it, vi } from 'vitest'
import { isAgentVisibleTo, agentIdentityForWebhook } from '@/lib/server/agentVisibility'

describe('isAgentVisibleTo', () => {
  const publicAgent = { id: 'agent-1', profile_visibility: 'public' }
  const privateAgent = { id: 'agent-1', profile_visibility: 'private' }

  it('is always visible when the agent is public, regardless of caller', () => {
    expect(isAgentVisibleTo(null, publicAgent)).toBe(true)
    expect(isAgentVisibleTo({ agent_id: 'someone-else' }, publicAgent)).toBe(true)
  })

  it('fails closed for a missing or unknown visibility value', () => {
    expect(isAgentVisibleTo(null, { id: 'agent-1' })).toBe(false)
    expect(isAgentVisibleTo(null, { id: 'agent-1', profile_visibility: 'future-mode' })).toBe(false)
    expect(isAgentVisibleTo({ role: 'buyer', task_id: 'task-1' }, { id: 'agent-1' }, { taskId: 'task-1' })).toBe(false)
    expect(isAgentVisibleTo({ agent_id: 'agent-1' }, { id: 'agent-1' })).toBe(true)
    expect(isAgentVisibleTo({ tier: 'admin' }, { id: 'agent-1' })).toBe(true)
  })

  it('is not visible to no token at all', () => {
    expect(isAgentVisibleTo(null, privateAgent)).toBe(false)
    expect(isAgentVisibleTo(undefined, privateAgent)).toBe(false)
  })

  it('is visible to an admin token', () => {
    expect(isAgentVisibleTo({ tier: 'admin' }, privateAgent)).toBe(true)
  })

  it('is visible to the agent\'s own token', () => {
    expect(isAgentVisibleTo({ agent_id: 'agent-1', tier: 1 }, privateAgent)).toBe(true)
  })

  it('is not visible to a different agent\'s token', () => {
    expect(isAgentVisibleTo({ agent_id: 'agent-2', tier: 1 }, privateAgent)).toBe(false)
  })

  it('is not visible to a buyer token without a matching taskId option', () => {
    expect(isAgentVisibleTo({ role: 'buyer', task_id: 'task-1', org_id: 'org-1' }, privateAgent)).toBe(false)
  })

  it('is visible to a buyer token bound to the given taskId', () => {
    expect(isAgentVisibleTo({ role: 'buyer', task_id: 'task-1', org_id: 'org-1' }, privateAgent, { taskId: 'task-1' })).toBe(true)
  })

  it('is not visible to a buyer token bound to a different task', () => {
    expect(isAgentVisibleTo({ role: 'buyer', task_id: 'task-2', org_id: 'org-1' }, privateAgent, { taskId: 'task-1' })).toBe(false)
  })

  it('a general profile lookup (no taskId option) never grants buyer access, even for the right task', () => {
    // General profile endpoints (agent detail, reputation, reviews,
    // portfolio, task history) never pass taskId — only bid-level lookups
    // do — so a buyer token must not satisfy this call shape at all.
    expect(isAgentVisibleTo({ role: 'buyer', task_id: 'task-1', org_id: 'org-1' }, privateAgent)).toBe(false)
  })
})

describe('agentIdentityForWebhook', () => {
  function fakeDb(agentRow: { id: string; profile_visibility: string } | null) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: agentRow, error: null }),
          }),
        }),
      }),
    } as any
  }

  it('returns {} for a null/undefined agentId', async () => {
    expect(await agentIdentityForWebhook(fakeDb(null), null)).toEqual({})
    expect(await agentIdentityForWebhook(fakeDb(null), undefined)).toEqual({})
  })

  it('returns the real agent_id for a public agent', async () => {
    const db = fakeDb({ id: 'agent-1', profile_visibility: 'public' })
    expect(await agentIdentityForWebhook(db, 'agent-1')).toEqual({ agent_id: 'agent-1' })
  })

  it('returns only agent_private: true — no agent_id — for a private agent', async () => {
    const db = fakeDb({ id: 'agent-1', profile_visibility: 'private' })
    const result = await agentIdentityForWebhook(db, 'agent-1')
    expect(result).toEqual({ agent_private: true })
    expect(result).not.toHaveProperty('agent_id')
  })

  it('redacts a missing row or unknown visibility instead of leaking the id', async () => {
    expect(await agentIdentityForWebhook(fakeDb(null), 'agent-1')).toEqual({ agent_private: true })
    expect(await agentIdentityForWebhook(fakeDb({ id: 'agent-1', profile_visibility: 'future-mode' }), 'agent-1'))
      .toEqual({ agent_private: true })
  })

  it('redacts when the visibility lookup fails', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: { code: 'DB_DOWN', message: 'unavailable' } }),
          }),
        }),
      }),
    } as any
    expect(await agentIdentityForWebhook(db, 'agent-1')).toEqual({ agent_private: true })
  })
})
