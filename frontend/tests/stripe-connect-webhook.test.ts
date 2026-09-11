import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/payments/stripe-connect-webhook/route'

process.env.JWT_SECRET_KEY = 'test-secret-for-stripe-connect-webhook-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test'

// ─── Minimal in-memory Supabase mock ───────────────────────────────────────
// Real enough to exercise the actual idempotency (unique violation on a
// duplicate stripe_event_id) and readiness-regression (reading back a
// prior audit_logs snapshot) logic, rather than stubbing those decisions
// away. Tables not pre-created here (e.g. 'tasks', 'transactions') throw if
// touched at all — that is deliberate: it is itself proof this module
// never reaches them.
type Row = Record<string, any>

const UNIQUE_KEYS: Record<string, string[][]> = {
  stripe_connect_events: [['stripe_event_id']],
  stripe_connect_payouts: [['stripe_account_id', 'stripe_payout_id']],
}

let tables: Record<string, Row[]>
let dbCalls: string[]
let idCounter = 0
// Table names present here return a database error from single()/maybeSingle() —
// used to prove a genuine DB failure produces a 500 rather than being
// silently swallowed.
let forcedErrors: Record<string, boolean>

function resetDb() {
  tables = { agents: [], audit_logs: [], stripe_connect_events: [], stripe_connect_payouts: [] }
  dbCalls = []
  idCounter = 0
  forcedErrors = {}
}
resetDb()

function makeDb() {
  return {
    from(table: string) {
      dbCalls.push(table)
      if (!(table in tables)) throw new Error(`test mock: table "${table}" was never initialized — unexpected access`)

      const filters: [string, any][] = []
      let pendingInsert: Row | null = null
      let pendingUpdate: Row | null = null

      const rowsMatchingFilters = () => tables[table].filter((r) => filters.every(([k, v]) => r[k] === v))

      const hasUniqueConflict = (row: Row) => {
        for (const cols of UNIQUE_KEYS[table] ?? []) {
          if (tables[table].some((r) => cols.every((c) => r[c] === row[c]))) return true
        }
        return false
      }

      const builder: any = {
        select() {
          return builder
        },
        eq(field: string, value: any) {
          filters.push([field, value])
          return builder
        },
        order() {
          return builder
        },
        limit() {
          return builder
        },
        insert(row: Row) {
          idCounter += 1
          pendingInsert = { id: `${table}-${idCounter}`, ...row }
          return builder
        },
        update(values: Row) {
          pendingUpdate = values
          return builder
        },
        async single() {
          if (forcedErrors[table]) return { data: null, error: { code: 'XX000', message: 'connection reset' } }
          if (pendingInsert) {
            if (hasUniqueConflict(pendingInsert)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
            }
            tables[table].push(pendingInsert)
            return { data: pendingInsert, error: null }
          }
          const rows = rowsMatchingFilters()
          if (rows.length !== 1) return { data: null, error: { message: 'not found or not exactly one row' } }
          return { data: rows[0], error: null }
        },
        async maybeSingle() {
          if (forcedErrors[table]) return { data: null, error: { code: 'XX000', message: 'connection reset' } }
          if (pendingUpdate) {
            const rows = rowsMatchingFilters()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return { data: rows[0] ?? null, error: null }
          }
          if (pendingInsert) {
            if (hasUniqueConflict(pendingInsert)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
            }
            tables[table].push(pendingInsert)
            return { data: pendingInsert, error: null }
          }
          const rows = rowsMatchingFilters()
          return { data: rows[0] ?? null, error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          if (pendingUpdate) {
            const rows = rowsMatchingFilters()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return resolve({ data: rows, error: null })
          }
          if (pendingInsert) {
            if (hasUniqueConflict(pendingInsert)) {
              return resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
            }
            tables[table].push(pendingInsert)
            return resolve({ data: [pendingInsert], error: null })
          }
          return resolve({ data: rowsMatchingFilters(), error: null })
        },
      }
      return builder
    },
  }
}

vi.mock('@/lib/server/supabase', () => ({ getSupabase: () => makeDb() }))

const { sendPayoutFailedAdminAlert, sendPayoutFailedAgentNotice } = vi.hoisted(() => ({
  sendPayoutFailedAdminAlert: vi.fn(async () => {}),
  sendPayoutFailedAgentNotice: vi.fn(async () => {}),
}))
vi.mock('@/lib/server/email', () => ({ sendPayoutFailedAdminAlert, sendPayoutFailedAgentNotice }))

const constructEvent = vi.fn((rawBody: string, signature: string) => {
  if (signature !== 'valid-signature') throw new Error('signature verification failed')
  return JSON.parse(rawBody)
})
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return { webhooks: { constructEvent } }
  }),
}))

function webhookRequest(event: unknown, signature = 'valid-signature') {
  return new NextRequest('http://localhost/api/v1/payments/stripe-connect-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: JSON.stringify(event),
  })
}

function accountUpdatedEvent(overrides: Partial<Row> = {}, accountOverrides: Partial<Row> = {}) {
  return {
    id: overrides.id ?? 'evt_account_1',
    type: 'account.updated',
    account: overrides.account ?? 'acct_agent_1',
    data: {
      object: {
        id: overrides.account ?? 'acct_agent_1',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [] },
        capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
        ...accountOverrides,
      },
    },
  }
}

function payoutEvent(type: string, overrides: Partial<Row> = {}, payoutOverrides: Partial<Row> = {}) {
  return {
    id: overrides.id ?? `evt_${type}_1`,
    type,
    account: overrides.account ?? 'acct_agent_1',
    data: {
      object: {
        id: payoutOverrides.id ?? 'po_1',
        amount: 12345,
        currency: 'eur',
        status: type === 'payout.failed' ? 'failed' : type === 'payout.paid' ? 'paid' : 'pending',
        arrival_date: 1735689600,
        failure_code: null,
        ...payoutOverrides,
      },
    },
  }
}

const AGENT_ID = 'agent-db-1'

beforeEach(() => {
  resetDb()
  tables.agents.push({ id: AGENT_ID, stripe_account_id: 'acct_agent_1', stripe_onboarding_completed: true, owner_email: 'agent-owner@example.com' })
  sendPayoutFailedAdminAlert.mockClear()
  sendPayoutFailedAgentNotice.mockClear()
  constructEvent.mockClear()
})

describe('POST /api/v1/payments/stripe-connect-webhook — configuration and signature', () => {
  it('returns 503 when STRIPE_CONNECT_WEBHOOK_SECRET is not set', async () => {
    const original = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    try {
      const response = await POST(webhookRequest(accountUpdatedEvent()))
      expect(response.status).toBe(503)
    } finally {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = original
    }
  })

  it('returns 400 on an invalid signature, without ever touching the database', async () => {
    const response = await POST(webhookRequest(accountUpdatedEvent(), 'wrong-signature'))
    expect(response.status).toBe(400)
    expect(dbCalls).toHaveLength(0)
  })

  it('verifies against the exact raw request body', async () => {
    await POST(webhookRequest(accountUpdatedEvent()))
    expect(constructEvent).toHaveBeenCalledWith(JSON.stringify(accountUpdatedEvent()), 'valid-signature', 'whsec_connect_test')
  })
})

describe('account.updated', () => {
  it('syncs stripe_onboarding_completed and records a readiness snapshot for a correctly-signed event', async () => {
    tables.agents[0].stripe_onboarding_completed = false
    const response = await POST(webhookRequest(accountUpdatedEvent()))
    expect(response.status).toBe(200)

    expect(tables.agents[0].stripe_onboarding_completed).toBe(true)
    const snapshot = tables.audit_logs.find((a) => a.action === 'stripe_connect_account_snapshot')
    expect(snapshot).toBeTruthy()
    expect(snapshot!.details.charges_enabled).toBe(true)
  })

  it('detects and audit-logs a loss of readiness (charges_enabled false) even when it is not the first event for this account', async () => {
    await POST(webhookRequest(accountUpdatedEvent({ id: 'evt_account_first' })))

    const response = await POST(
      webhookRequest(accountUpdatedEvent({ id: 'evt_account_second' }, { charges_enabled: false }))
    )
    expect(response.status).toBe(200)

    const lost = tables.audit_logs.find((a) => a.action === 'stripe_connect_readiness_lost')
    expect(lost).toBeTruthy()
    expect(lost!.details.regressed).toContain('charges_enabled')
  })

  it('does not activate onboarding_completed from a single boolean — a missing payment-method capability keeps it false even with charges_enabled and payouts_enabled true', async () => {
    tables.agents[0].stripe_onboarding_completed = false
    const response = await POST(
      webhookRequest(
        accountUpdatedEvent({}, { capabilities: { card_payments: 'inactive', sepa_debit_payments: 'inactive', transfers: 'active' } })
      )
    )
    expect(response.status).toBe(200)
    expect(tables.agents[0].stripe_onboarding_completed).toBe(false)
  })

  it('detects and audit-logs restoration back to readiness after a prior loss', async () => {
    await POST(webhookRequest(accountUpdatedEvent({ id: 'evt_a' })))
    await POST(webhookRequest(accountUpdatedEvent({ id: 'evt_b' }, { payouts_enabled: false })))
    expect(tables.agents[0].stripe_onboarding_completed).toBe(false)

    await POST(webhookRequest(accountUpdatedEvent({ id: 'evt_c' }, { payouts_enabled: true })))
    expect(tables.agents[0].stripe_onboarding_completed).toBe(true)
  })

  it('handles an account.updated event for an unknown connected account without erroring', async () => {
    const response = await POST(webhookRequest(accountUpdatedEvent({ account: 'acct_unknown' })))
    expect(response.status).toBe(200)
    const unknown = tables.audit_logs.find((a) => a.action === 'stripe_connect_unknown_account')
    expect(unknown).toBeTruthy()
    expect(unknown!.details.stripe_account_id).toBe('acct_unknown')
  })

  it('never touches tasks or transactions', async () => {
    await POST(webhookRequest(accountUpdatedEvent()))
    expect(dbCalls).not.toContain('tasks')
    expect(dbCalls).not.toContain('transactions')
  })
})

describe('payout events', () => {
  it('records payout.paid and never sends a failure alert', async () => {
    const response = await POST(webhookRequest(payoutEvent('payout.paid')))
    expect(response.status).toBe(200)

    const row = tables.stripe_connect_payouts[0]
    expect(row.status).toBe('paid')
    expect(row.agent_id).toBe(AGENT_ID)
    expect(row.amount).toBe(123.45)
    expect(row.currency).toBe('eur')
    expect(sendPayoutFailedAdminAlert).not.toHaveBeenCalled()
    expect(sendPayoutFailedAgentNotice).not.toHaveBeenCalled()
  })

  it('never stores a bank account number, account holder name, or the raw Stripe object', async () => {
    await POST(
      webhookRequest(
        payoutEvent('payout.paid', {}, {
          destination: 'ba_secret123',
          bank_account: { account_holder_name: 'Jan Novák', last4: '1234' },
        } as any)
      )
    )
    const row = tables.stripe_connect_payouts[0]
    expect(row).not.toHaveProperty('destination')
    expect(row).not.toHaveProperty('bank_account')
    expect(Object.keys(row).sort()).toEqual(
      ['agent_id', 'amount', 'arrival_date', 'currency', 'failure_code', 'id', 'status', 'stripe_account_id', 'stripe_payout_id'].sort()
    )
  })

  it('payout.failed creates an admin alert and, when owner_email is on file, an agent notice — and never changes task or transaction state', async () => {
    const response = await POST(webhookRequest(payoutEvent('payout.failed', {}, { failure_code: 'account_closed' })))
    expect(response.status).toBe(200)

    const row = tables.stripe_connect_payouts[0]
    expect(row.status).toBe('failed')
    expect(row.failure_code).toBe('account_closed')

    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledTimes(1)
    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: 'po_1', stripeAccountId: 'acct_agent_1', agentId: AGENT_ID, failureCode: 'account_closed' })
    )
    expect(sendPayoutFailedAgentNotice).toHaveBeenCalledTimes(1)
    expect(sendPayoutFailedAgentNotice).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent-owner@example.com' }))

    expect(dbCalls).not.toContain('tasks')
    expect(dbCalls).not.toContain('transactions')
  })

  it('does not send an agent notice when the agent has no owner_email on file', async () => {
    tables.agents[0].owner_email = null
    const response = await POST(webhookRequest(payoutEvent('payout.failed')))
    expect(response.status).toBe(200)
    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledTimes(1)
    expect(sendPayoutFailedAgentNotice).not.toHaveBeenCalled()
  })

  it('still records the payout and still sends the admin alert for an unrecognized connected account, but sends no agent notice', async () => {
    const response = await POST(webhookRequest(payoutEvent('payout.failed', { account: 'acct_unknown' })))
    expect(response.status).toBe(200)

    const row = tables.stripe_connect_payouts[0]
    expect(row.agent_id).toBeNull()
    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }))
    expect(sendPayoutFailedAgentNotice).not.toHaveBeenCalled()
  })

  it('does not re-alert when payout.failed is followed by another failed-status event for the same payout', async () => {
    await POST(webhookRequest(payoutEvent('payout.failed', { id: 'evt_1' })))
    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledTimes(1)

    // A later event for the SAME payout that still reports 'failed' (e.g. a
    // payout.updated Stripe sends afterward) must not fire a second alert —
    // only the transition INTO failed does.
    await POST(webhookRequest(payoutEvent('payout.updated', { id: 'evt_2' }, { status: 'failed' } as any)))
    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledTimes(1)
  })

  it('upserts by (stripe_account_id, stripe_payout_id) rather than creating a second row when the same payout transitions status', async () => {
    await POST(webhookRequest(payoutEvent('payout.created', { id: 'evt_1' }, { status: 'pending' } as any)))
    await POST(webhookRequest(payoutEvent('payout.paid', { id: 'evt_2' }, { status: 'paid' } as any)))

    expect(tables.stripe_connect_payouts).toHaveLength(1)
    expect(tables.stripe_connect_payouts[0].status).toBe('paid')
  })

  it('a payout for one agent never touches another agent\'s payout row', async () => {
    tables.agents.push({ id: 'agent-db-2', stripe_account_id: 'acct_agent_2', stripe_onboarding_completed: true, owner_email: 'other@example.com' })

    await POST(webhookRequest(payoutEvent('payout.paid', { account: 'acct_agent_1', id: 'evt_for_agent1' }, { id: 'po_a' })))
    await POST(webhookRequest(payoutEvent('payout.paid', { account: 'acct_agent_2', id: 'evt_for_agent2' }, { id: 'po_b' })))

    const forAgent1 = tables.stripe_connect_payouts.filter((p) => p.agent_id === AGENT_ID)
    const forAgent2 = tables.stripe_connect_payouts.filter((p) => p.agent_id === 'agent-db-2')
    expect(forAgent1).toHaveLength(1)
    expect(forAgent2).toHaveLength(1)
    expect(forAgent1[0].stripe_payout_id).toBe('po_a')
    expect(forAgent2[0].stripe_payout_id).toBe('po_b')
  })
})

describe('idempotent, concurrency-safe event receipt', () => {
  it('processes a brand-new event exactly once and marks it completed', async () => {
    const response = await POST(webhookRequest(payoutEvent('payout.paid', { id: 'evt_once' })))
    expect(response.status).toBe(200)
    expect(tables.stripe_connect_events).toHaveLength(1)
    expect(tables.stripe_connect_events[0].status).toBe('completed')
  })

  it('redelivery of the exact same event id does not reprocess or duplicate the audit trail', async () => {
    const event = payoutEvent('payout.failed', { id: 'evt_dup' })
    await POST(webhookRequest(event))
    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledTimes(1)
    const payoutRowsAfterFirst = tables.stripe_connect_payouts.length
    const auditRowsAfterFirst = tables.audit_logs.length

    const secondResponse = await POST(webhookRequest(event))
    expect(secondResponse.status).toBe(200)
    const secondBody = await secondResponse.json()
    expect(secondBody.duplicate).toBe(true)

    expect(sendPayoutFailedAdminAlert).toHaveBeenCalledTimes(1)
    expect(tables.stripe_connect_payouts).toHaveLength(payoutRowsAfterFirst)
    expect(tables.audit_logs).toHaveLength(auditRowsAfterFirst)
    expect(tables.stripe_connect_events).toHaveLength(1)
  })

  it('a concurrent duplicate delivery (two claims racing on the same event id) lets exactly one claim it', async () => {
    const { claimConnectEvent } = await import('@/lib/server/stripeConnectMonitoring')
    const db = makeDb() as any
    const event = payoutEvent('payout.paid', { id: 'evt_race' }) as any

    const [first, second] = await Promise.all([claimConnectEvent(db, event), claimConnectEvent(db, event)])
    const claims = [first, second]

    expect(claims.filter((c) => c.claimed)).toHaveLength(1)
    expect(claims.filter((c) => !c.claimed)).toHaveLength(1)
    expect(tables.stripe_connect_events).toHaveLength(1)
  })

  it('reclaims and retries an event that previously failed, once a later delivery arrives', async () => {
    tables.stripe_connect_events.push({ id: 'evt-row-1', stripe_event_id: 'evt_retry', event_type: 'payout.paid', stripe_account_id: 'acct_agent_1', status: 'failed' })
    const response = await POST(webhookRequest(payoutEvent('payout.paid', { id: 'evt_retry' })))
    expect(response.status).toBe(200)
    expect(tables.stripe_connect_events.find((e) => e.stripe_event_id === 'evt_retry')?.status).toBe('completed')
    expect(tables.stripe_connect_payouts).toHaveLength(1)
  })

  it('a database error while claiming the event returns 500 so Stripe retries, without partially processing it', async () => {
    forcedErrors.stripe_connect_events = true
    const response = await POST(webhookRequest(payoutEvent('payout.paid', { id: 'evt_dberror' })))
    expect(response.status).toBe(500)
    expect(sendPayoutFailedAdminAlert).not.toHaveBeenCalled()
    expect(tables.stripe_connect_payouts).toHaveLength(0)
  })

  it('a database error during processing marks the event failed and returns 500, without marking it completed', async () => {
    forcedErrors.agents = true
    const response = await POST(webhookRequest(payoutEvent('payout.paid', { id: 'evt_process_error' })))
    expect(response.status).toBe(500)
    expect(tables.stripe_connect_events.find((e) => e.stripe_event_id === 'evt_process_error')?.status).toBe('failed')
    expect(tables.stripe_connect_payouts).toHaveLength(0)
  })
})
