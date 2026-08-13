import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as getAgent } from '@/app/api/v1/agents/[id]/route'
import { GET as getTask } from '@/app/api/v1/tasks/[id]/route'

const AGENT_ID = '61d9be5a-ee68-498f-ad1c-493536409c18'
const TASK_ID = '420e4e5a-9399-4c27-bc31-41af73d7245b'

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
let selectedTaskColumns = ''

const rawTask = {
  id: TASK_ID,
  title: 'Analyse a B2B dataset',
  description: 'Produce a decision-ready report.',
  category: 'data_analysis',
  required_capabilities: ['research', 'analysis'],
  required_languages: ['en'],
  budget_min_eur: 300,
  budget_max_eur: 500,
  deadline_hours: 72,
  status: 'open',
  assigned_agent_id: null,
  posted_by_org_id: 'organization-private',
  bidding_closes_at: '2026-08-14T12:00:00.000Z',
  created_at: '2026-08-13T12:00:00.000Z',
  assigned_at: null,
  delivery_deadline_at: null,
  // These fields must remain private even if a query or future schema change
  // accidentally makes them available to the handler.
  buyer_email: 'buyer@example.com',
  buyer_token: 'buyer-token-private',
  delivery_note: 'Private delivered work',
  dispute_reason: 'Private buyer message',
  embedding: [0.3, 0.4],
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      const result = table === 'agents'
        ? { data: rawAgent, error: null }
        : table === 'tasks'
          ? { data: rawTask, error: null }
          : { data: [{ rating: 5 }], error: null }

      const builder: Record<string, any> = {
        select(columns: string) {
          if (table === 'agents') selectedAgentColumns = columns
          if (table === 'tasks') selectedTaskColumns = columns
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
    const response = await getAgent(request, { params: { id: AGENT_ID } })
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

describe('GET /api/v1/tasks/[id]', () => {
  it('returns only public task fields', async () => {
    const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`)
    const response = await getTask(request, { params: { id: TASK_ID } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      id: TASK_ID,
      title: 'Analyse a B2B dataset',
      status: 'open',
      delivery_deadline_at: null,
    })
    expect(selectedTaskColumns).not.toBe('*')

    for (const privateField of [
      'buyer_email',
      'buyer_token',
      'posted_by_org_id',
      'delivery_note',
      'dispute_reason',
      'embedding',
    ]) {
      expect(body).not.toHaveProperty(privateField)
      expect(selectedTaskColumns.split(',')).not.toContain(privateField)
    }
  })
})
