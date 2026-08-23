import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.JWT_SECRET_KEY = 'test-secret-for-hire-moderation-32-chars!'

const insertedTasks: Record<string, unknown>[] = []
const insertedBids: Record<string, unknown>[] = []

const listingRow = {
  id: 'listing-1',
  title: 'Translate a document',
  description: 'A perfectly ordinary translation service with no red flags at all.',
  category: 'translation',
  price_eur: 50,
  delivery_hours: 24,
  hires_count: 0,
  agent_id: 'agent-1',
  is_active: true,
  agents: { id: 'agent-1', display_name: 'Translator Bot', is_active: true },
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      let insertedRow: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        single: async () => {
          if (table === 'agent_listings') return { data: listingRow, error: null }
          if (table === 'organizations') return { data: { id: 'org-1' }, error: null }
          if (table === 'tasks') return { data: { id: 'task-1', ...insertedRow }, error: null }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'organizations') return { data: null, error: null }
          return { data: null, error: null }
        },
        insert: (values: Record<string, unknown>) => {
          if (table === 'tasks') { insertedTasks.push(values); insertedRow = values }
          if (table === 'bids') insertedBids.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/email', () => ({ sendTaskCreated: vi.fn(async () => {}) }))
vi.mock('@/lib/server/webhooks', () => ({ fireWebhooks: vi.fn(async () => {}) }))

beforeEach(() => {
  insertedTasks.length = 0
  insertedBids.length = 0
})

describe('POST /api/v1/store/[listingId]/hire — moderation', () => {
  it('persists moderation_status=approved and published_at on a hired task — the reported gap', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const response = await POST(request, { params: { listingId: 'listing-1' } })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(insertedTasks).toHaveLength(1)
    // Before the fix, moderation_status was absent here entirely, so the
    // row defaulted to 'pending' in the database despite this 201 response
    // and the accepted bid created below telling the buyer it was live.
    expect(insertedTasks[0]).toMatchObject({ moderation_status: 'approved' })
    expect(insertedTasks[0]).toHaveProperty('published_at')
    expect((insertedTasks[0] as any).published_at).not.toBeNull()
    expect(insertedBids).toHaveLength(1)
    expect(body).toHaveProperty('task_id')
  })

  it('blocks a listing whose content fails moderation, creating nothing', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const original = { ...listingRow }
    Object.assign(listingRow, {
      title: 'Verify wallet',
      description: 'We just need your seed phrase to confirm you own the wallet, nothing else.',
    })
    try {
      const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const response = await POST(request, { params: { listingId: 'listing-1' } })
      expect(response.status).toBe(422)
      expect(insertedTasks).toHaveLength(0)
      expect(insertedBids).toHaveLength(0)
    } finally {
      Object.assign(listingRow, original)
    }
  })
})
