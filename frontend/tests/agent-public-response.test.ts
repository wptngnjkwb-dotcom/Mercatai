import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/agents/[id]/route'

const AGENT_ID = '61d9be5a-ee68-498f-ad1c-493536409c18'

const rawAgent = {
  id: AGENT_ID,
  agent_id: 'decision-data-studio-codex',
  display_name: 'Decision Data Studio',
  description: 'Decision support agent',
  capabilities: ['research'],
  languages: ['en'],
  verification_level: 'anonymous',
  reputation_score: 50,
  tier: 1,
  free_tasks_remaining: 10,
  total_tasks_completed: 0,
  success_rate: 0,
  is_active: true,
  registered_at: '2026-07-23T12:37:00.332177+00:00',
  stripe_onboarding_completed: false,
  // A defensive response allowlist must exclude these even if a future
  // database mock or query accidentally supplies them.
  is_approved: false,
  api_key_hash: '$2b$10$not-public',
  owner_org_id: 'org-private',
  gdpr_consent_at: '2026-07-23T12:37:00.075+00:00',
  stripe_account_id: 'acct_private',
  webhook_url: 'https://private.example/webhook',
  webhook_secret: 'whsec_private',
  wallet_balance_eur: 100,
  monthly_spending_limit_eur: 200,
  embedding: [0.1, 0.2],
}

let selectedAgentColumns = ''

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const result = table === 'agents'
        ? { data: rawAgent, error: null }
        : { data: [{ rating: 5 }], error: null }

      const builder: Record<string, any> = {
        select(columns: string) {
          if (table === 'agents') selectedAgentColumns = columns
          return builder
        },
        eq: () => builder,
        single: async () => result,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('GET /api/v1/agents/[id]', () => {
  it('returns only public profile fields', async () => {
    const request = new NextRequest(`http://localhost/api/v1/agents/${AGENT_ID}`)
    const response = await GET(request, { params: { id: AGENT_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      id: AGENT_ID,
      agent_id: 'decision-data-studio-codex',
      display_name: 'Decision Data Studio',
      is_active: true,
      avg_rating: 5,
      review_count: 1,
    })
    expect(selectedAgentColumns).not.toBe('*')

    for (const privateField of [
      'is_approved',
      'api_key_hash',
      'owner_org_id',
      'gdpr_consent_at',
      'stripe_account_id',
      'webhook_url',
      'webhook_secret',
      'wallet_balance_eur',
      'monthly_spending_limit_eur',
      'embedding',
    ]) {
      expect(body).not.toHaveProperty(privateField)
      expect(selectedAgentColumns.split(',')).not.toContain(privateField)
    }
  })
})
