import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest } from 'next/server'
import { GET as getTask } from '@/app/api/v1/tasks/[id]/route'
import { signToken } from '@/lib/server/auth'
import { canReadDeliveredWork } from '@/lib/server/deliveredWork'
import { GET as getOpenApi } from '@/app/api/v1/openapi/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-delivered-work-visibility-32c'

const TASK_ID = '8a1f0c2e-1111-4c27-bc31-41af73d7245b'
const OTHER_TASK_ID = '8a1f0c2e-2222-4c27-bc31-41af73d7245b'
const ASSIGNED_AGENT_ID = '3c5d7e9f-3333-4a2e-9c3b-7d1f0a5e6b4c'
const OTHER_AGENT_ID = '3c5d7e9f-4444-4a2e-9c3b-7d1f0a5e6b4c'
const DELIVERY_NOTE = 'Final report\n\nSee section 2 <script>alert(1)</script>'

const taskRow: Record<string, any> = {}
const selectedTaskColumns: string[] = []
let failDeliveryLookup = false

function resetTask() {
  for (const key of Object.keys(taskRow)) delete taskRow[key]
  Object.assign(taskRow, {
    id: TASK_ID,
    title: 'Market scan',
    description: 'Scan the market.',
    category: 'research',
    required_capabilities: ['research'],
    required_languages: ['en'],
    budget_min_eur: 10,
    budget_max_eur: 20,
    deadline_hours: 24,
    status: 'review',
    assigned_agent_id: ASSIGNED_AGENT_ID,
    bidding_closes_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-08-30T00:00:00.000Z',
    assigned_at: '2026-08-31T00:00:00.000Z',
    delivery_deadline_at: '2026-09-02T00:00:00.000Z',
    moderation_status: 'approved',
    posted_by_org_id: 'org-buyer',
    archived_at: null,
    archived_reason: null,
    stripe_account_requirement: 'standard_agent_liability',
    buyer_email: 'buyer@example.com',
    delivery_note: DELIVERY_NOTE,
  })
}

// Projects exactly the selected columns, like PostgREST — so a response can
// only ever contain delivery_note if the handler explicitly selected it.
function project(row: Record<string, any>, columns: string) {
  return Object.fromEntries(columns.split(',').map((c) => c.trim()).filter(Boolean).map((c) => [c, row[c]]))
}

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      let columns = '*'
      const builder: Record<string, any> = {
        select(cols: string) {
          columns = cols
          if (table === 'tasks') selectedTaskColumns.push(cols)
          return builder
        },
        eq: () => builder,
        in: () => builder,
        single: async () => {
          if (table !== 'tasks') return { data: null, error: { code: 'PGRST116' } }
          if (failDeliveryLookup && columns.includes('delivery_note')) {
            return { data: null, error: { code: 'XX000', message: 'simulated' } }
          }
          return { data: project(taskRow, columns), error: null }
        },
        then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) => {
          const data =
            table === 'organizations' ? [{ id: 'org-buyer', is_platform_seed: false }]
            : table === 'transactions' ? [{ id: 'tx-1', task_id: TASK_ID, escrow_status: 'held', created_at: '2026-08-31T00:00:00.000Z' }]
            : table === 'agents' ? [{ id: ASSIGNED_AGENT_ID, profile_visibility: 'public' }]
            : []
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
      }
      return builder
    },
  }),
}))

async function fetchTask(bearer?: string) {
  const request = new NextRequest(`http://localhost/api/v1/tasks/${TASK_ID}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
  const response = await getTask(request, { params: { id: TASK_ID } })
  return { status: response.status, body: await response.json() }
}

describe('GET /api/v1/tasks/[id] — delivered work visibility', () => {
  beforeEach(() => {
    resetTask()
    selectedTaskColumns.length = 0
    failDeliveryLookup = false
  })

  it('(a) anonymous caller gets the public shape: no delivery_note, never even selected', async () => {
    const { status, body } = await fetchTask()
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('delivery_note')
    expect(body).not.toHaveProperty('buyer_email')
    expect(selectedTaskColumns).toHaveLength(1)
    expect(selectedTaskColumns[0].split(',')).not.toContain('delivery_note')
  })

  it('(b) the task\'s own buyer token gets delivery_note verbatim (newlines preserved)', async () => {
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-buyer', buyer_email: 'buyer@example.com' }, '30d')
    const { status, body } = await fetchTask(buyerToken)
    expect(status).toBe(200)
    expect(body.delivery_note).toBe(DELIVERY_NOTE)
    expect(body).not.toHaveProperty('buyer_email')
  })

  it('(c) a buyer token for a different task does not get delivery_note', async () => {
    const otherBuyer = await signToken({ role: 'buyer', task_id: OTHER_TASK_ID, org_id: 'org-other' }, '30d')
    const { status, body } = await fetchTask(otherBuyer)
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('delivery_note')
  })

  it('(d) another agent does not get delivery_note', async () => {
    const otherAgent = await signToken({ agent_id: OTHER_AGENT_ID, tier: 1 }, '15m')
    const { body } = await fetchTask(otherAgent)
    expect(body).not.toHaveProperty('delivery_note')
  })

  it('(e) the assigned agent gets delivery_note', async () => {
    const agentToken = await signToken({ agent_id: ASSIGNED_AGENT_ID, tier: 1 }, '15m')
    const { body } = await fetchTask(agentToken)
    expect(body.delivery_note).toBe(DELIVERY_NOTE)
  })

  it('(e) an admin gets delivery_note', async () => {
    const adminToken = await signToken({ tier: 'admin' }, '12h')
    const { body } = await fetchTask(adminToken)
    expect(body.delivery_note).toBe(DELIVERY_NOTE)
  })

  it('an authorized caller gets delivery_note: null before delivery', async () => {
    taskRow.status = 'in_progress'
    taskRow.delivery_note = null
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-buyer' }, '30d')
    const { body } = await fetchTask(buyerToken)
    expect(body).toHaveProperty('delivery_note', null)
  })

  it('fails closed: invalid, refresh, or OAuth-slug tokens get the public shape', async () => {
    const refresh = await signToken({ agent_id: ASSIGNED_AGENT_ID, type: 'refresh' }, '7d')
    const oauthSlug = await signToken({ role: 'oauth', agent_id: 'assigned-agent-slug', scopes: ['tasks:read'] }, '1h')
    const buyerNoTaskId = await signToken({ role: 'buyer', org_id: 'org-buyer' }, '30d')
    const buyerWithAgentClaim = await signToken({ role: 'buyer', task_id: OTHER_TASK_ID, agent_id: ASSIGNED_AGENT_ID }, '30d')
    for (const bearer of ['not-a-jwt', refresh, oauthSlug, buyerNoTaskId, buyerWithAgentClaim]) {
      const { status, body } = await fetchTask(bearer)
      expect(status).toBe(200)
      expect(body).not.toHaveProperty('delivery_note')
    }
  })

  it('fails closed: a delivery_note lookup error yields the public shape, not a 500', async () => {
    failDeliveryLookup = true
    const buyerToken = await signToken({ role: 'buyer', task_id: TASK_ID, org_id: 'org-buyer' }, '30d')
    const { status, body } = await fetchTask(buyerToken)
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('delivery_note')
  })

  it('canReadDeliveredWork never matches an unassigned task by a missing agent id', () => {
    expect(canReadDeliveredWork({ agent_id: undefined }, { id: TASK_ID, assigned_agent_id: null })).toBe(false)
    expect(canReadDeliveredWork({}, { id: TASK_ID, assigned_agent_id: null })).toBe(false)
    expect(canReadDeliveredWork(null, { id: TASK_ID, assigned_agent_id: ASSIGNED_AGENT_ID })).toBe(false)
  })
})

describe('buyer review page renders delivered work as plain text', () => {
  const page = readFileSync(join(__dirname, '..', 'app', '[locale]', '(buyer)', 'buyer', 'tasks', '[id]', 'bids', 'page.tsx'), 'utf-8')

  it('loads the task with the task-bound buyer token and never injects HTML', () => {
    expect(page).toContain('api.getBuyerTask(id)')
    expect(page).toContain('{task.delivery_note}')
    expect(page).toContain('whitespace-pre-wrap')
    expect(page).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('OpenAPI documents delivered-work visibility', () => {
  it('Task.delivery_note is documented as buyer / assigned agent / admin only', async () => {
    const spec = await (await getOpenApi()).json()
    const description: string = spec.components.schemas.Task.properties.delivery_note.description
    expect(description).toMatch(/buyer/)
    expect(description).toMatch(/assigned agent/)
    expect(description).toMatch(/admin/)
    expect(description).toMatch(/absent/)
    expect(spec.paths['/api/v1/tasks/{id}/deliver'].post.description).toMatch(/emails the buyer/)
  })
})
