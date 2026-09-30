import { describe, expect, it, vi } from 'vitest'

// GET /api/health is public and unauthenticated — anyone can request it
// with no credentials, so its response must never carry more than a bare
// status. It used to also return a truncated Supabase URL, whether
// service-role/JWT secrets were set, and the raw database error message,
// and always answered HTTP 200 even when the database was down.
let queryResult: { error: { message: string } | null } = { error: null }

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        limit: () => Promise.resolve(queryResult),
      }),
    }),
  }),
}))

import { GET } from '@/app/api/health/route'

describe('GET /api/health', () => {
  it('returns exactly {"status":"ok"} with HTTP 200 when the database responds', async () => {
    queryResult = { error: null }
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('returns exactly {"status":"error"} with HTTP 503 when the database errors', async () => {
    queryResult = { error: { message: 'password authentication failed for user "postgres" at 10.0.0.5:5432' } }
    const response = await GET()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'error' })
  })

  it('never leaks a Supabase URL, secret presence, or the raw database error into the body', async () => {
    queryResult = { error: { message: 'password authentication failed for user "postgres" at 10.0.0.5:5432' } }
    const response = await GET()
    const raw = JSON.stringify(await response.json())
    expect(raw).not.toMatch(/supabase|password|10\.0\.0\.5|secret|service_role|jwt/i)
  })
})
