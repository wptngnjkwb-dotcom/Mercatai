import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// A tiny in-memory simulation of the organizations table, keyed the same
// way the real route queries it — org by id (insert-then-select), and org
// by join_token_lookup_id (the join flow). Real bcrypt runs against it
// (not mocked), since the whole point of these tests is verifying the
// actual hash-and-compare, not a mocked stand-in for it.
let orgSeq = 0
const orgsById: Record<string, { id: string; name: string; is_suspended: boolean; join_token_lookup_id: string | null; join_token_secret_hash: string | null }> = {}
const orgsByLookupId: Record<string, string> = {}
let agentInsertError: { code: string } | null = null

// Backing rows for GET /api/v1/agents (list), tested alongside POST here
// since both live in the same route file (isolate:false — see the shared
// memory on not mocking one route's dependencies from two files).
const listAgentRows: Record<string, unknown>[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      let pendingInsert: Record<string, unknown> | null = null
      let pendingUpdate: Record<string, unknown> | null = null
      const builder: Record<string, any> = {
        select: () => builder,
        eq: (field: string, value: unknown) => { eqFilters.push([field, value]); return builder },
        contains: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (values: Record<string, unknown>) => {
          if (table === 'organizations') {
            orgSeq += 1
            const id = `org-${orgSeq}`
            orgsById[id] = { id, name: String(values.name), is_suspended: false, join_token_lookup_id: null, join_token_secret_hash: null }
            pendingInsert = { id }
          }
          if (table === 'agents') pendingInsert = { id: 'agent-row-1', agent_id: values.agent_id, display_name: values.display_name, profile_visibility: values.profile_visibility }
          return builder
        },
        update: (values: Record<string, unknown>) => { pendingUpdate = values; return builder },
        single: async () => {
          if (table === 'organizations') return { data: pendingInsert, error: null }
          if (table === 'agents') return agentInsertError ? { data: null, error: agentInsertError } : { data: pendingInsert, error: null }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'organizations') {
            const lookupFilter = eqFilters.find(([f]) => f === 'join_token_lookup_id')
            if (lookupFilter) {
              const orgId = orgsByLookupId[lookupFilter[1] as string]
              return { data: orgId ? orgsById[orgId] : null, error: null }
            }
          }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'organizations' && pendingUpdate) {
            const idFilter = eqFilters.find(([f]) => f === 'id')
            if (idFilter) {
              const id = idFilter[1] as string
              Object.assign(orgsById[id], pendingUpdate)
              if (pendingUpdate.join_token_lookup_id) {
                orgsByLookupId[pendingUpdate.join_token_lookup_id as string] = id
              }
            }
            return resolve({ data: null, error: null })
          }
          if (table === 'agents' && !pendingInsert) {
            // GET /api/v1/agents (list) — filter listAgentRows by every .eq() applied.
            const filtered = listAgentRows.filter((r) => eqFilters.every(([f, v]) => r[f] === v))
            return resolve({ data: filtered, error: null })
          }
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/server/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('@/lib/server/rateLimit', () => ({ isRateLimited: vi.fn(async () => false), clientIp: vi.fn(() => '127.0.0.1') }))

beforeEach(() => {
  orgSeq = 0
  for (const k of Object.keys(orgsById)) delete orgsById[k]
  for (const k of Object.keys(orgsByLookupId)) delete orgsByLookupId[k]
  agentInsertError = null
  listAgentRows.length = 0
})

function registerRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: `agent-${Math.random().toString(36).slice(2)}`,
      display_name: 'Test Agent',
      gdpr_consent: true,
      owner_email: 'default-test@example.com',
      ...body,
    }),
  })
}

describe('POST /api/v1/agents — organization identity via join tokens', () => {
  it('owner_email is never used to look up or attach to an existing organization', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    // First registration creates an org named after this email.
    await POST(registerRequest({ owner_email: 'someone@realcompany.com' }))
    expect(Object.keys(orgsById)).toHaveLength(1)

    // A second, unrelated registration typing the SAME email string must
    // not attach to that first organization — before the fix, this is
    // exactly how an attacker could join any company's org roster just by
    // knowing (not owning) their public contact email.
    await POST(registerRequest({ owner_email: 'someone@realcompany.com' }))
    expect(Object.keys(orgsById)).toHaveLength(2)
  })

  it('rejects registration with no owner_email', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ owner_email: undefined }))
    expect(response.status).toBe(400)
    expect(Object.keys(orgsById)).toHaveLength(0)
  })

  it('rejects registration with an owner_email that has no @', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ owner_email: 'not-an-email' }))
    expect(response.status).toBe(400)
    expect(Object.keys(orgsById)).toHaveLength(0)
  })

  it('rejects an owner_email with two @ signs — a looser .includes() check would let this through', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ owner_email: 'a@b.c@d.com' }))
    expect(response.status).toBe(400)
    expect(Object.keys(orgsById)).toHaveLength(0)
  })

  it('normalizes owner_email (trim + lowercase) before storing it', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    await POST(registerRequest({ owner_email: '  SOMEONE@Example.COM  ' }))
    const [orgId] = Object.keys(orgsById)
    expect(orgsById[orgId].name).toBe('someone@example.com')
  })

  it('a fresh registration with no join token returns one, generated for that new org', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({}))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(typeof body.organization_join_token).toBe('string')
    expect(body.organization_join_token).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{32}$/)

    const [orgId] = Object.keys(orgsById)
    expect(orgsById[orgId].join_token_secret_hash).toBeTruthy()
    // The plaintext secret is never itself stored.
    expect(orgsById[orgId].join_token_secret_hash).not.toBe(body.organization_join_token.split('.')[1])
  })

  it('a second agent presenting the first agent\'s join token joins the SAME organization, with no new token issued', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const first = await POST(registerRequest({}))
    const firstBody = await first.json()
    const orgCountAfterFirst = Object.keys(orgsById).length

    const second = await POST(registerRequest({ organization_join_token: firstBody.organization_join_token }))
    const secondBody = await second.json()

    expect(second.status).toBe(201)
    expect(Object.keys(orgsById)).toHaveLength(orgCountAfterFirst) // no new org created
    expect(secondBody).not.toHaveProperty('organization_join_token') // only issued once, to the creator
  })

  it('rejects a join token with the wrong secret', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const first = await POST(registerRequest({}))
    const firstBody = await first.json()
    const [lookupId] = firstBody.organization_join_token.split('.')
    const forged = `${lookupId}.${'0'.repeat(32)}`

    const response = await POST(registerRequest({ organization_join_token: forged }))
    expect(response.status).toBe(400)
  })

  it('rejects a join token whose lookup id matches nothing', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ organization_join_token: `${'a'.repeat(32)}.${'b'.repeat(32)}` }))
    expect(response.status).toBe(400)
  })

  it('rejects a malformed join token (missing the secret half)', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ organization_join_token: 'not-a-valid-token' }))
    expect(response.status).toBe(400)
  })

  it('rejects joining a suspended organization', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const first = await POST(registerRequest({}))
    const firstBody = await first.json()
    const [orgId] = Object.keys(orgsById)
    orgsById[orgId].is_suspended = true

    const response = await POST(registerRequest({ organization_join_token: firstBody.organization_join_token }))
    expect(response.status).toBe(403)
  })
})

describe('POST /api/v1/agents — profile_visibility', () => {
  it('defaults to public when not provided', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({}))
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.profile_visibility).toBe('public')
  })

  it('accepts an explicit private', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ profile_visibility: 'private' }))
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.profile_visibility).toBe('private')
  })

  it('rejects an invalid value with 400', async () => {
    const { POST } = await import('@/app/api/v1/agents/route')
    const response = await POST(registerRequest({ profile_visibility: 'hidden' }))
    expect(response.status).toBe(400)
  })
})

describe('GET /api/v1/agents — excludes private agents', () => {
  it('never returns an agent whose profile_visibility is private', async () => {
    listAgentRows.push(
      { id: 'agent-pub', agent_id: 'agent-pub', display_name: 'Pub', is_active: true, profile_visibility: 'public' },
      { id: 'agent-priv', agent_id: 'agent-priv', display_name: 'Priv', is_active: true, profile_visibility: 'private' },
    )
    const { GET } = await import('@/app/api/v1/agents/route')
    const response = await GET(new NextRequest('http://localhost/api/v1/agents'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.agents.some((a: any) => a.id === 'agent-priv')).toBe(false)
    expect(body.agents.some((a: any) => a.id === 'agent-pub')).toBe(true)
  })
})
