import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const insertedOrgs: Record<string, unknown>[] = []
const insertedClients: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        single: async () => {
          if (table === 'organizations') return { data: { id: 'org-new' }, error: null }
          if (table === 'api_clients') return { data: { id: 'client-1', name: insertedClients.at(-1)?.name, scopes: insertedClients.at(-1)?.scopes, rate_limit_per_hour: 1000, created_at: '2026-08-23T00:00:00Z' }, error: null }
          return { data: null, error: null }
        },
        insert: (values: Record<string, unknown>) => {
          if (table === 'organizations') insertedOrgs.push(values)
          if (table === 'api_clients') insertedClients.push(values)
          return builder
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))

beforeEach(() => {
  insertedOrgs.length = 0
  insertedClients.length = 0
})

describe('POST /api/v1/developer/clients — organization identity', () => {
  it('org_name is never used to look up or attach to an existing organization', async () => {
    const { POST } = await import('@/app/api/v1/developer/clients/route')
    const request = new NextRequest('http://localhost/api/v1/developer/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // This endpoint is unauthenticated — anyone could type an existing
      // organization's exact name (including the platform's own seed org)
      // and, before the fix, have their new API client attached to it.
      body: JSON.stringify({ name: 'My App', org_name: 'Mercatai Sample Briefs' }),
    })
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(insertedOrgs).toHaveLength(1)
    expect(insertedOrgs[0]).toMatchObject({ name: 'Mercatai Sample Briefs' })
    expect(body).toHaveProperty('api_key')
  })

  it('falls back to the client name as the org label when org_name is omitted', async () => {
    const { POST } = await import('@/app/api/v1/developer/clients/route')
    const request = new NextRequest('http://localhost/api/v1/developer/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Other App' }),
    })
    const response = await POST(request)
    expect(response.status).toBe(201)
    expect(insertedOrgs).toHaveLength(1)
    expect(insertedOrgs[0]).toMatchObject({ name: 'My Other App' })
  })

  it('two clients with the identical org_name get two distinct organizations', async () => {
    const { POST } = await import('@/app/api/v1/developer/clients/route')
    const mkRequest = () => new NextRequest('http://localhost/api/v1/developer/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', org_name: 'Acme Corp' }),
    })
    await POST(mkRequest())
    await POST(mkRequest())
    expect(insertedOrgs).toHaveLength(2)
    expect(insertedOrgs.every((o) => (o as any).name === 'Acme Corp')).toBe(true)
  })
})
