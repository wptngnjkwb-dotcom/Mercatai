import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.JWT_SECRET_KEY = 'test-secret-for-hire-moderation-32-chars!'

const insertedTasks: Record<string, unknown>[] = []
const insertedBids: Record<string, unknown>[] = []
const insertedOrgs: Record<string, unknown>[] = []
const rpcCalls: { name: string; args: Record<string, unknown> }[] = []

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
  agents: { id: 'agent-1', display_name: 'Translator Bot', is_active: true, profile_visibility: 'public' },
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return { data: [{
        task_id: 'task-1', buyer_org_id: 'org-1', agent_id: 'agent-1',
        task_title: listingRow.title, price_eur: listingRow.price_eur,
        delivery_hours: listingRow.delivery_hours,
        agent_display_name: listingRow.agents.display_name,
        assigned_at: '2026-09-01T00:00:00.000Z',
      }], error: null }
    },
    from(table: string) {
      let insertedRow: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        single: async () => {
          if (table === 'agent_listings') return { data: listingRow, error: null }
          if (table === 'agents') return { data: { id: 'agent-1', profile_visibility: listingRow.agents.profile_visibility }, error: null }
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
          if (table === 'organizations') insertedOrgs.push(values)
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
  insertedOrgs.length = 0
  rpcCalls.length = 0
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
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]).toMatchObject({ name: 'create_store_hire', args: {
      p_listing_id: 'listing-1', p_expected_agent_id: 'agent-1',
      p_moderation_policy_version: expect.any(String),
    } })
    // Organization, approved task, accepted bid and counter are created
    // inside this single transaction rather than independent app writes.
    expect(insertedTasks).toHaveLength(0)
    expect(insertedBids).toHaveLength(0)
    expect(body).toHaveProperty('task_id')
    expect(body.delivery_deadline_at).toBeNull()
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

  it('org_name is never used to look up or attach to an existing organization', async () => {
    const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
    const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ org_name: 'Mercatai Sample Briefs' }),
    })
    const response = await POST(request, { params: { listingId: 'listing-1' } })
    expect(response.status).toBe(201)
    expect(insertedOrgs).toHaveLength(0)
    expect(rpcCalls[0]).toMatchObject({ args: { p_org_name: 'Mercatai Sample Briefs' } })
  })
})

describe('POST /api/v1/store/[listingId]/hire — private-agent listing', () => {
  it('rejects instant-hire by direct listingId when the listing\'s agent is private — a known listingId must not bypass the Store list filter', async () => {
    const original = { ...listingRow, agents: { ...listingRow.agents } }
    Object.assign(listingRow, { agents: { ...listingRow.agents, profile_visibility: 'private' } })
    try {
      const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
      const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const response = await POST(request, { params: { listingId: 'listing-1' } })

      expect(response.status).toBe(404)
      expect(insertedTasks).toHaveLength(0)
      expect(insertedBids).toHaveLength(0)
    } finally {
      Object.assign(listingRow, original)
    }
  })

  it('fails closed when the joined agent has no recognized visibility value', async () => {
    const original = { ...listingRow, agents: { ...listingRow.agents } }
    Object.assign(listingRow, { agents: { ...listingRow.agents, profile_visibility: 'future-mode' as any } })
    try {
      const { POST } = await import('@/app/api/v1/store/[listingId]/hire/route')
      const request = new NextRequest('http://localhost/api/v1/store/listing-1/hire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const response = await POST(request, { params: { listingId: 'listing-1' } })
      expect(response.status).toBe(404)
      expect(insertedTasks).toHaveLength(0)
    } finally {
      Object.assign(listingRow, original)
    }
  })
})
