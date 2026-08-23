import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const AGENT_ID = 'agent-with-history'

const rawTask = {
  id: 'task-1',
  title: 'Analyse a dataset',
  description: 'Produce a decision-ready report.',
  category: 'data_analysis',
  budget_min_eur: 100,
  budget_max_eur: 200,
  deadline_hours: 48,
  status: 'completed',
  assigned_agent_id: AGENT_ID,
  created_at: '2026-08-01T00:00:00.000Z',
  assigned_at: '2026-08-01T01:00:00.000Z',
  delivery_deadline_at: '2026-08-03T00:00:00.000Z',
  moderation_status: 'approved',
  // Must never leak through this public, unauthenticated endpoint.
  buyer_email: 'buyer@example.com',
  buyer_token: 'buyer-token-private',
  delivery_note: 'Private delivered work',
  dispute_reason: 'Private buyer message',
  posted_by_org_id: 'org-private',
  embedding: [0.1, 0.2],
  moderation_risk_score: 0,
  moderation_reason_codes: [],
  moderated_by: 'system:auto',
}

let selectedColumns = ''

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const builder: Record<string, any> = {
        select(columns: string) {
          if (table === 'tasks') selectedColumns = columns
          return builder
        },
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        order: () => builder,
        limit: () => builder,
        then: (resolve: (v: unknown) => unknown) => {
          if (table !== 'tasks') return resolve({ data: [], error: null })
          const matches = eqFilters.every(([f, v]) => (rawTask as Record<string, unknown>)[f] === v)
          return resolve({ data: matches ? [rawTask] : [], error: null })
        },
      }
      return builder
    },
  }),
}))

describe('GET /api/v1/agents/[id]/tasks', () => {
  it('returns only public fields for an approved task, filtered to that agent', async () => {
    const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
    const response = await GET(request, { params: { id: AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.tasks).toHaveLength(1)
    expect(selectedColumns).not.toBe('*')

    for (const privateField of [
      'buyer_email', 'buyer_token', 'delivery_note', 'dispute_reason',
      'posted_by_org_id', 'embedding', 'moderation_risk_score', 'moderation_reason_codes', 'moderated_by',
    ]) {
      expect(body.tasks[0]).not.toHaveProperty(privateField)
      expect(selectedColumns.split(',')).not.toContain(privateField)
    }
  })

  it('excludes a task that is not approved — same filter GET /tasks/[id] applies', async () => {
    const original = rawTask.moderation_status
    ;(rawTask as any).moderation_status = 'quarantined'
    try {
      const { GET } = await import('@/app/api/v1/agents/[id]/tasks/route')
      const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}/tasks`)
      const response = await GET(request, { params: { id: AGENT_ID } })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.tasks).toEqual([])
    } finally {
      ;(rawTask as any).moderation_status = original
    }
  })
})
