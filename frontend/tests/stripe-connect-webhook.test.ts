import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/v1/payments/stripe-connect-webhook/route'
import {
  claimConnectEvent,
  markConnectEventCompleted,
  markConnectEventFailed,
  claimPayoutAdminAlert,
  markAdminAlertSent,
  markAdminAlertFailed,
  buildPayoutAlertIdempotencyKey,
} from '@/lib/server/stripeConnectMonitoring'

process.env.JWT_SECRET_KEY = 'test-secret-for-stripe-connect-webhook-32ch'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.ADMIN_ALERT_EMAIL = 'admin@example.com'
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test'

// ─── Minimal in-memory Supabase + RPC mock ─────────────────────────────────
// Real enough to exercise the actual lease/claim semantics (a real
// unique-violation on a duplicate stripe_event_id, a real staleness check
// on processing_started_at, a real claim_token match on completion) rather
// than stubbing those decisions away — this mirrors
// claim_stripe_connect_event() and claim_payout_admin_alert() in
// frontend/sql/14_stripe_connect_monitoring.sql closely enough that a bug
// in either implementation would show up here. Tables not pre-created
// (e.g. 'tasks', 'transactions') throw if touched at all — proof this
// module never reaches them.
type Row = Record<string, any>

const UNIQUE_KEYS: Record<string, string[][]> = {
  stripe_connect_events: [['stripe_event_id']],
  stripe_connect_payouts: [['stripe_account_id', 'stripe_payout_id']],
}

let tables: Record<string, Row[]>
let dbCalls: string[]
let idCounter = 0
// Table names present here return a database error from single()/maybeSingle()/then() —
// used to prove a genuine DB failure produces a 500 rather than being
// silently swallowed.
let forcedErrors: Record<string, boolean>
// One-shot: the NEXT update that sets admin_alert_status to 'sent' fails
// with a real Supabase error, then clears itself — used to simulate
// "Resend accepted the email but recording that in the DB failed".
let forceNextSentWriteToFail = false

function resetDb() {
  tables = { agents: [], audit_logs: [], stripe_connect_events: [], stripe_connect_payouts: [], stripe_connect_account_status: [] }
  dbCalls = []
  idCounter = 0
  forcedErrors = {}
  forceNextSentWriteToFail = false
}
resetDb()

function claimStripeConnectEventMock(args: Row) {
  if (forcedErrors.stripe_connect_events) return { data: null, error: { code: 'XX000', message: 'connection reset' } }
  const table = tables.stripe_connect_events
  const idx = table.findIndex((r) => r.stripe_event_id === args.p_stripe_event_id)
  idCounter += 1
  const newToken = `token-${idCounter}`

  if (idx === -1) {
    const row = {
      id: `evt-row-${idCounter}`,
      stripe_event_id: args.p_stripe_event_id,
      event_type: args.p_event_type,
      stripe_account_id: args.p_stripe_account_id,
      status: 'processing',
      claim_token: newToken,
      processing_started_at: new Date().toISOString(),
      attempt_count: 1,
      last_error: null,
      completed_at: null,
    }
    table.push(row)
    return { data: [{ id: row.id, claim_token: newToken, attempt_count: 1 }], error: null }
  }

  const row = table[idx]
  const leaseMs = (args.p_lease_seconds ?? 300) * 1000
  const isStaleProcessing = row.status === 'processing' && Date.now() - new Date(row.processing_started_at).getTime() > leaseMs
  if (row.status === 'failed' || isStaleProcessing) {
    row.status = 'processing'
    row.claim_token = newToken
    row.processing_started_at = new Date().toISOString()
    row.attempt_count = (row.attempt_count ?? 0) + 1
    return { data: [{ id: row.id, claim_token: newToken, attempt_count: row.attempt_count }], error: null }
  }
  return { data: [], error: null }
}

// Mirrors claim_payout_admin_alert() in frontend/sql/14_stripe_connect_monitoring.sql:
// mints a new token and atomically increments admin_alert_attempts on
// every successful claim, and only ever ADOPTS the passed payload
// snapshot when none is stored yet (COALESCE) — every subsequent claim
// returns whatever was frozen by the very first one, unchanged.
function claimPayoutAdminAlertMock(args: Row) {
  if (forcedErrors.stripe_connect_payouts) return { data: null, error: { code: 'XX000', message: 'connection reset' } }
  const row = tables.stripe_connect_payouts.find((r) => r.id === args.p_payout_row_id)
  if (!row) return { data: [], error: null }
  const leaseMs = (args.p_lease_seconds ?? 300) * 1000
  const staleSending = row.admin_alert_status === 'sending' && row.admin_alert_claimed_at && Date.now() - new Date(row.admin_alert_claimed_at).getTime() > leaseMs
  if (row.admin_alert_status === 'pending' || row.admin_alert_status === 'failed' || staleSending) {
    idCounter += 1
    const newToken = `alert-token-${idCounter}`
    row.admin_alert_status = 'sending'
    row.admin_alert_claimed_at = new Date().toISOString()
    row.admin_alert_claim_token = newToken
    row.admin_alert_attempts = (row.admin_alert_attempts ?? 0) + 1
    if (row.admin_alert_payload_snapshot == null) row.admin_alert_payload_snapshot = args.p_payload_snapshot ?? null
    return { data: [{ claim_token: newToken, attempt_count: row.admin_alert_attempts, payload_snapshot: row.admin_alert_payload_snapshot }], error: null }
  }
  return { data: [], error: null }
}

// Mirrors real Postgres column DEFAULTs — the mock's insert() only stores
// exactly what's passed unless seeded here, but a real INSERT into
// stripe_connect_payouts always gets admin_alert_status = 'pending' etc.
// from the schema even when the application code doesn't set them
// explicitly (see backend/db/schema.sql / frontend/sql/14_*.sql).
const TABLE_INSERT_DEFAULTS: Record<string, Row> = {
  stripe_connect_payouts: {
    admin_alert_status: 'pending',
    admin_alert_claim_token: null,
    admin_alert_claimed_at: null,
    admin_alert_sent_at: null,
    admin_alert_attempts: 0,
    admin_alert_payload_snapshot: null,
    admin_alert_provider_id: null,
    last_alert_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
}

function makeDb() {
  return {
    async rpc(fnName: string, args: Row) {
      if (fnName === 'claim_stripe_connect_event') return claimStripeConnectEventMock(args)
      if (fnName === 'claim_payout_admin_alert') return claimPayoutAdminAlertMock(args)
      throw new Error(`test mock: unknown rpc ${fnName}`)
    },
    from(table: string) {
      dbCalls.push(table)
      if (!(table in tables)) throw new Error(`test mock: table "${table}" was never initialized — unexpected access`)

      const filters: [string, any][] = []
      let pendingInsert: Row | null = null
      let pendingUpdate: Row | null = null
      let pendingUpsert: { row: Row; conflictKey?: string } | null = null

      const rowsMatchingFilters = () => tables[table].filter((r) => filters.every(([k, v]) => r[k] === v))
      const hasUniqueConflict = (row: Row) => (UNIQUE_KEYS[table] ?? []).some((cols) => tables[table].some((r) => cols.every((c) => r[c] === row[c])))

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
          pendingInsert = { id: `${table}-${idCounter}`, ...(TABLE_INSERT_DEFAULTS[table] ?? {}), ...row }
          return builder
        },
        update(values: Row) {
          pendingUpdate = values
          return builder
        },
        upsert(row: Row, opts?: { onConflict?: string }) {
          pendingUpsert = { row, conflictKey: opts?.onConflict }
          return builder
        },
        async single() {
          if (forcedErrors[table]) return { data: null, error: { code: 'XX000', message: 'connection reset' } }
          if (pendingInsert) {
            if (hasUniqueConflict(pendingInsert)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
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
            if (hasUniqueConflict(pendingInsert)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
            tables[table].push(pendingInsert)
            return { data: pendingInsert, error: null }
          }
          const rows = rowsMatchingFilters()
          return { data: rows[0] ?? null, error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          if (forcedErrors[table]) return resolve({ data: null, error: { code: 'XX000', message: 'connection reset' } })
          if (table === 'stripe_connect_payouts' && pendingUpdate?.admin_alert_status === 'sent' && forceNextSentWriteToFail) {
            forceNextSentWriteToFail = false
            return resolve({ data: null, error: { code: 'XX000', message: 'connection reset while recording sent' } })
          }
          if (pendingUpdate) {
            const rows = rowsMatchingFilters()
            for (const r of rows) Object.assign(r, pendingUpdate)
            return resolve({ data: rows, error: null })
          }
          if (pendingUpsert) {
            const key = pendingUpsert.conflictKey ?? 'id'
            const idx = tables[table].findIndex((r) => r[key] === pendingUpsert!.row[key])
            if (idx >= 0) tables[table][idx] = { ...tables[table][idx], ...pendingUpsert.row }
            else tables[table].push({ ...pendingUpsert.row })
            return resolve({ data: null, error: null })
          }
          if (pendingInsert) {
            if (hasUniqueConflict(pendingInsert)) return resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
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

const { sendPayoutFailedAdminAlertOrThrow, sendPayoutFailedAgentNotice } = vi.hoisted(() => ({
  sendPayoutFailedAdminAlertOrThrow: vi.fn(async (_payload: Record<string, unknown>, _idempotencyKey: string) => 'email-provider-id-1'),
  sendPayoutFailedAgentNotice: vi.fn(async (_params: Record<string, unknown>) => {}),
}))
// Only the two SEND functions are mocked — buildAdminAlertProviderPayload
// (and ADMIN_ALERT_PAYLOAD_VERSION) stay the REAL implementation, since
// this file's whole point is to exercise the genuine
// "build once, freeze, never re-render on retry" behavior end to end.
vi.mock('@/lib/server/email', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/email')>()
  return { ...original, sendPayoutFailedAdminAlertOrThrow, sendPayoutFailedAgentNotice }
})

// ─── Stripe mock: signature verification + "fetch current state" ──────────
// account/payout state is keyed by id and set per-test — this is what lets
// tests prove the handler uses the FRESH fetched state, not whatever the
// webhook event body happened to embed.
let accountStates: Record<string, Row>
let payoutStates: Record<string, Row>

function resetStripeStates() {
  accountStates = {}
  payoutStates = {}
}
resetStripeStates()

function defaultAccountState(overrides: Row = {}): Row {
  return {
    id: 'acct_agent_1',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    requirements: { currently_due: [] },
    capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'active' },
    ...overrides,
  }
}

function defaultPayoutState(overrides: Row = {}): Row {
  return {
    id: 'po_1',
    amount: 12345,
    currency: 'eur',
    status: 'pending',
    arrival_date: 1735689600,
    failure_code: null,
    ...overrides,
  }
}

const constructEvent = vi.fn((rawBody: string, signature: string) => {
  if (signature !== 'valid-signature') throw new Error('signature verification failed')
  return JSON.parse(rawBody)
})
const accountsRetrieve = vi.fn(async (id: string) => {
  const state = accountStates[id]
  if (!state) throw new Error('stripe: no such account')
  return state
})
const payoutsRetrieve = vi.fn(async (payoutId: string) => {
  const state = payoutStates[payoutId]
  if (!state) throw new Error('stripe: no such payout')
  return state
})
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return { webhooks: { constructEvent }, accounts: { retrieve: accountsRetrieve }, payouts: { retrieve: payoutsRetrieve } }
  }),
}))

function webhookRequest(event: unknown, signature = 'valid-signature') {
  return new NextRequest('http://localhost/api/v1/payments/stripe-connect-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: JSON.stringify(event),
  })
}

function accountUpdatedEvent(id: string, account = 'acct_agent_1') {
  return { id, type: 'account.updated', account, data: { object: { id: account } } }
}

function payoutEnvelope(id: string, type: string, account: string, payoutId: string, staleEmbeddedStatus = 'pending') {
  // The embedded object deliberately carries a status that may be stale —
  // the handler must ignore it and fetch fresh from Stripe instead.
  return { id, type, account, data: { object: { id: payoutId, status: staleEmbeddedStatus } } }
}

function externalAccountUpdatedEvent(id: string, account: string, status: string) {
  return {
    id,
    type: 'account.external_account.updated',
    account,
    data: { object: { object: 'bank_account', status, last4: '4242', account_holder_name: 'Should Never Be Stored', routing_number: '110000000' } },
  }
}

const AGENT_ID = 'agent-db-1'

beforeEach(() => {
  resetDb()
  resetStripeStates()
  tables.agents.push({ id: AGENT_ID, stripe_account_id: 'acct_agent_1', stripe_onboarding_completed: true, owner_email: 'agent-owner@example.com' })
  accountStates['acct_agent_1'] = defaultAccountState()
  payoutStates['po_1'] = defaultPayoutState()
  sendPayoutFailedAdminAlertOrThrow.mockClear()
  sendPayoutFailedAgentNotice.mockClear()
  constructEvent.mockClear()
  accountsRetrieve.mockClear()
  payoutsRetrieve.mockClear()
})

describe('POST /api/v1/payments/stripe-connect-webhook — configuration and signature', () => {
  it('returns 503 when STRIPE_CONNECT_WEBHOOK_SECRET is not set', async () => {
    const original = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    try {
      const response = await POST(webhookRequest(accountUpdatedEvent('evt_1')))
      expect(response.status).toBe(503)
    } finally {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = original
    }
  })

  it('returns 400 on an invalid signature, without ever touching the database', async () => {
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_1'), 'wrong-signature'))
    expect(response.status).toBe(400)
    expect(dbCalls).toHaveLength(0)
  })

  it('verifies against the exact raw request body', async () => {
    const event = accountUpdatedEvent('evt_verify')
    await POST(webhookRequest(event))
    expect(constructEvent).toHaveBeenCalledWith(JSON.stringify(event), 'valid-signature', 'whsec_connect_test')
  })
})

describe('account.updated — always re-fetches current state from Stripe', () => {
  it('syncs stripe_onboarding_completed from a freshly-fetched account, not the embedded event body', async () => {
    tables.agents[0].stripe_onboarding_completed = false
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_1')))
    expect(response.status).toBe(200)
    expect(accountsRetrieve).toHaveBeenCalledWith('acct_agent_1')
    expect(tables.agents[0].stripe_onboarding_completed).toBe(true)

    const status = tables.stripe_connect_account_status.find((s) => s.stripe_account_id === 'acct_agent_1')
    expect(status).toBeTruthy()
    expect(status!.charges_enabled).toBe(true)
  })

  it('does not activate onboarding_completed from a single boolean — a missing payment-method capability keeps it false even with charges/payouts enabled', async () => {
    tables.agents[0].stripe_onboarding_completed = false
    accountStates['acct_agent_1'] = defaultAccountState({ capabilities: { card_payments: 'inactive', sepa_debit_payments: 'inactive', transfers: 'active' } })
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_1')))
    expect(response.status).toBe(200)
    expect(tables.agents[0].stripe_onboarding_completed).toBe(false)
  })

  it('detects and audit-logs a capability regression using the reliable status table, not audit_logs itself', async () => {
    await POST(webhookRequest(accountUpdatedEvent('evt_first')))
    accountStates['acct_agent_1'] = defaultAccountState({ charges_enabled: false })
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_second')))
    expect(response.status).toBe(200)

    const lost = tables.audit_logs.find((a) => a.action === 'stripe_connect_readiness_lost')
    expect(lost).toBeTruthy()
    expect(lost!.details.regressed).toContain('charges_enabled')

    const status = tables.stripe_connect_account_status.find((s) => s.stripe_account_id === 'acct_agent_1')
    expect(status!.charges_enabled).toBe(false)
  })

  it('an out-of-order (late) account.updated event never restores stale readiness — it always reflects the CURRENT live Stripe state, not its own embedded snapshot', async () => {
    // The account genuinely lost readiness by the time this event is
    // processed, even though the event's own embedded object (never read
    // for account.updated at all) would represent an older, "still ready"
    // moment if it were consulted.
    accountStates['acct_agent_1'] = defaultAccountState({ charges_enabled: false })
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_late')))
    expect(response.status).toBe(200)

    const status = tables.stripe_connect_account_status.find((s) => s.stripe_account_id === 'acct_agent_1')
    expect(status!.charges_enabled).toBe(false)
  })

  it('handles an account.updated event for an unknown connected account without erroring', async () => {
    accountStates['acct_unknown'] = defaultAccountState({ id: 'acct_unknown' })
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_1', 'acct_unknown')))
    expect(response.status).toBe(200)
    const unknown = tables.audit_logs.find((a) => a.action === 'stripe_connect_unknown_account')
    expect(unknown).toBeTruthy()
    expect(unknown!.details.stripe_account_id).toBe('acct_unknown')
  })

  it('returns 500 without updating any state when the Stripe fetch itself fails, and never leaks the raw Stripe error', async () => {
    accountsRetrieve.mockRejectedValueOnce(new Error('Stripe internal detail that must never reach a client'))
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_1')))
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('Stripe internal detail')
    expect(tables.stripe_connect_account_status).toHaveLength(0)
    expect(tables.agents[0].stripe_onboarding_completed).toBe(true) // unchanged from its seeded value
  })

  it('never touches tasks or transactions', async () => {
    await POST(webhookRequest(accountUpdatedEvent('evt_1')))
    expect(dbCalls).not.toContain('tasks')
    expect(dbCalls).not.toContain('transactions')
  })
})

describe('account.external_account.updated', () => {
  it('captures only a coarse status and account type — never last4, routing number, account holder name, or the raw object', async () => {
    const response = await POST(webhookRequest(externalAccountUpdatedEvent('evt_ext_1', 'acct_agent_1', 'errored')))
    expect(response.status).toBe(200)

    const entry = tables.audit_logs.find((a) => a.action === 'stripe_connect_external_account_updated')
    expect(entry).toBeTruthy()
    expect(entry!.details).toEqual({ stripe_account_id: 'acct_agent_1', external_account_type: 'bank_account', status: 'errored' })
    expect(JSON.stringify(entry!.details)).not.toMatch(/4242|110000000|Should Never Be Stored/)
  })
})

describe('payout events — always re-fetches current state from Stripe', () => {
  it('records payout.paid from the freshly-fetched payout and never sends a failure alert', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'paid' })
    const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.paid', 'acct_agent_1', 'po_1')))
    expect(response.status).toBe(200)
    expect(payoutsRetrieve).toHaveBeenCalledWith('po_1', { stripeAccount: 'acct_agent_1' })

    const row = tables.stripe_connect_payouts[0]
    expect(row.status).toBe('paid')
    expect(row.agent_id).toBe(AGENT_ID)
    expect(row.amount_minor).toBe(12345)
    expect(row.currency).toBe('eur')
    expect(sendPayoutFailedAdminAlertOrThrow).not.toHaveBeenCalled()
    expect(sendPayoutFailedAgentNotice).not.toHaveBeenCalled()
  })

  it('stores amount_minor as Stripe\'s raw integer, never divided, so precision is exact', async () => {
    payoutStates['po_1'] = defaultPayoutState({ amount: 99999, currency: 'eur', status: 'paid' })
    await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.paid', 'acct_agent_1', 'po_1')))
    expect(tables.stripe_connect_payouts[0].amount_minor).toBe(99999)
  })

  it('never stores a bank account number, account holder name, or the raw Stripe object', async () => {
    payoutStates['po_1'] = { ...defaultPayoutState({ status: 'paid' }), destination: 'ba_secret123', bank_account: { account_holder_name: 'Jan Novák', last4: '1234' } }
    await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.paid', 'acct_agent_1', 'po_1')))
    const row = tables.stripe_connect_payouts[0]
    expect(row).not.toHaveProperty('destination')
    expect(row).not.toHaveProperty('bank_account')
    expect(Object.keys(row).sort()).toEqual(
      [
        'agent_id', 'amount_minor', 'arrival_date', 'currency', 'failure_code', 'id', 'status', 'stripe_account_id', 'stripe_payout_id',
        'admin_alert_status', 'admin_alert_claim_token', 'admin_alert_claimed_at', 'admin_alert_sent_at', 'admin_alert_attempts',
        'admin_alert_payload_snapshot', 'admin_alert_provider_id', 'last_alert_error', 'created_at', 'updated_at',
      ].sort()
    )
  })

  it('a late payout.created (embedding a stale "pending" snapshot) never reverts an already-paid payout — it re-fetches and finds the current truth', async () => {
    // Establish 'paid' first.
    payoutStates['po_1'] = defaultPayoutState({ status: 'paid' })
    await POST(webhookRequest(payoutEnvelope('evt_paid', 'payout.paid', 'acct_agent_1', 'po_1', 'paid')))
    expect(tables.stripe_connect_payouts[0].status).toBe('paid')

    // A LATE payout.created arrives. Its embedded object still says
    // 'pending' (a stale snapshot from creation time) — but Stripe's own
    // live state (what the handler actually fetches) is still 'paid'.
    const response = await POST(webhookRequest(payoutEnvelope('evt_created_late', 'payout.created', 'acct_agent_1', 'po_1', 'pending')))
    expect(response.status).toBe(200)
    expect(tables.stripe_connect_payouts[0].status).toBe('paid')
  })

  it('a late payout.created never reverts an already-failed payout either', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed', failure_code: 'account_closed' })
    await POST(webhookRequest(payoutEnvelope('evt_failed', 'payout.failed', 'acct_agent_1', 'po_1', 'failed')))
    expect(tables.stripe_connect_payouts[0].status).toBe('failed')

    const response = await POST(webhookRequest(payoutEnvelope('evt_created_late', 'payout.created', 'acct_agent_1', 'po_1', 'pending')))
    expect(response.status).toBe(200)
    expect(tables.stripe_connect_payouts[0].status).toBe('failed')
  })

  it('returns 500 without writing any payout row when the Stripe fetch itself fails, and never leaks the raw Stripe error', async () => {
    payoutsRetrieve.mockRejectedValueOnce(new Error('Stripe internal detail that must never reach a client'))
    const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.paid', 'acct_agent_1', 'po_1')))
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('Stripe internal detail')
    expect(tables.stripe_connect_payouts).toHaveLength(0)
  })

  it('upserts by (stripe_account_id, stripe_payout_id) rather than creating a second row when the same payout transitions status', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'pending' })
    await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.created', 'acct_agent_1', 'po_1')))
    payoutStates['po_1'] = defaultPayoutState({ status: 'paid' })
    await POST(webhookRequest(payoutEnvelope('evt_2', 'payout.paid', 'acct_agent_1', 'po_1')))

    expect(tables.stripe_connect_payouts).toHaveLength(1)
    expect(tables.stripe_connect_payouts[0].status).toBe('paid')
  })

  it('a payout for one agent never touches another agent\'s payout row', async () => {
    tables.agents.push({ id: 'agent-db-2', stripe_account_id: 'acct_agent_2', stripe_onboarding_completed: true, owner_email: 'other@example.com' })
    accountStates['acct_agent_2'] = defaultAccountState({ id: 'acct_agent_2' })
    payoutStates['po_a'] = defaultPayoutState({ id: 'po_a', status: 'paid' })
    payoutStates['po_b'] = defaultPayoutState({ id: 'po_b', status: 'paid' })

    await POST(webhookRequest(payoutEnvelope('evt_for_agent1', 'payout.paid', 'acct_agent_1', 'po_a')))
    await POST(webhookRequest(payoutEnvelope('evt_for_agent2', 'payout.paid', 'acct_agent_2', 'po_b')))

    const forAgent1 = tables.stripe_connect_payouts.filter((p) => p.agent_id === AGENT_ID)
    const forAgent2 = tables.stripe_connect_payouts.filter((p) => p.agent_id === 'agent-db-2')
    expect(forAgent1).toHaveLength(1)
    expect(forAgent2).toHaveLength(1)
    expect(forAgent1[0].stripe_payout_id).toBe('po_a')
    expect(forAgent2[0].stripe_payout_id).toBe('po_b')
  })

  it('never touches tasks or transactions on payout.failed', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(dbCalls).not.toContain('tasks')
    expect(dbCalls).not.toContain('transactions')
  })
})

describe('payout.failed — reliable, retryable, deduplicated admin alert', () => {
  it('sends exactly one admin alert and one best-effort agent notice on the transition into failed', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed', failure_code: 'account_closed' })
    const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(response.status).toBe(200)

    const row = tables.stripe_connect_payouts[0]
    expect(row.status).toBe('failed')
    expect(row.admin_alert_status).toBe('sent')
    expect(row.admin_alert_sent_at).toBeTruthy()

    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)
    const [sentPayload, sentIdempotencyKey] = sendPayoutFailedAdminAlertOrThrow.mock.calls[0]
    expect(sentPayload.to).toBe('admin@example.com')
    expect(sentPayload.html).toContain('po_1')
    expect(sentPayload.html).toContain('acct_agent_1')
    expect(sentPayload.html).toContain(AGENT_ID)
    expect(sentPayload.html).toContain('account_closed')
    expect(sentIdempotencyKey).toBe('payout-failed-alert:acct_agent_1:po_1')
    expect(sendPayoutFailedAgentNotice).toHaveBeenCalledTimes(1)
    expect(sendPayoutFailedAgentNotice).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent-owner@example.com' }))
  })

  it('does not send an agent notice when the agent has no owner_email on file, but still sends the admin alert', async () => {
    tables.agents[0].owner_email = null
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(response.status).toBe(200)
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)
    expect(sendPayoutFailedAgentNotice).not.toHaveBeenCalled()
  })

  it('still records the payout and still sends the admin alert for an unrecognized connected account, but sends no agent notice', async () => {
    accountStates['acct_unknown'] = defaultAccountState({ id: 'acct_unknown' })
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_unknown', 'po_1')))
    expect(response.status).toBe(200)

    const row = tables.stripe_connect_payouts[0]
    expect(row.agent_id).toBeNull()
    const [sentPayload] = sendPayoutFailedAdminAlertOrThrow.mock.calls[0]
    expect(sentPayload.html).toContain('unrecognized connected account')
    expect(sendPayoutFailedAgentNotice).not.toHaveBeenCalled()
  })

  it('does not re-alert on a later event for the same payout that still reports failed', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)

    await POST(webhookRequest(payoutEnvelope('evt_2', 'payout.updated', 'acct_agent_1', 'po_1')))
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)
  })

  it('a failed admin-alert send is retried by a later delivery, and the event is not marked completed in the meantime', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    sendPayoutFailedAdminAlertOrThrow.mockRejectedValueOnce(new Error('Resend API unavailable'))

    const firstResponse = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(firstResponse.status).toBe(500)

    let row = tables.stripe_connect_payouts[0]
    expect(row.status).toBe('failed') // payout state was still recorded
    expect(row.admin_alert_status).toBe('failed')
    expect(row.admin_alert_attempts).toBe(1)
    expect(row.last_alert_error).toMatch(/Resend API unavailable/)
    expect(tables.stripe_connect_events[0].status).toBe('failed') // event itself was not completed

    // A later delivery of the SAME event (Stripe's own retry) succeeds.
    const secondResponse = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(secondResponse.status).toBe(200)

    row = tables.stripe_connect_payouts[0]
    expect(row.admin_alert_status).toBe('sent')
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(2)
    expect(tables.stripe_connect_events[0].status).toBe('completed')
  })

  it('two concurrent/duplicate failure events for the same payout send exactly one admin alert', async () => {
    // Exercised at the handlePayoutEvent level directly (bypassing the
    // HTTP/route layer) — this is what actually implements the
    // deduplication (claim_payout_admin_alert), and is what two DIFFERENT
    // Stripe event ids for the same payout would both call, genuinely
    // concurrently, if delivered close together.
    const { handlePayoutEvent } = await import('@/lib/server/stripeConnectMonitoring')
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    const db = makeDb() as any
    const stripeMock = { accounts: { retrieve: accountsRetrieve }, payouts: { retrieve: payoutsRetrieve } } as any

    await Promise.all([
      handlePayoutEvent(db, stripeMock, payoutEnvelope('evt_a', 'payout.failed', 'acct_agent_1', 'po_1') as any),
      handlePayoutEvent(db, stripeMock, payoutEnvelope('evt_b', 'payout.updated', 'acct_agent_1', 'po_1') as any),
    ])

    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)
    expect(tables.stripe_connect_payouts).toHaveLength(1)
    expect(tables.stripe_connect_payouts[0].admin_alert_status).toBe('sent')
  })

  it('a generic send failure is never treated as success — the event is not completed', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    sendPayoutFailedAdminAlertOrThrow.mockRejectedValueOnce(new Error('Resend API unavailable'))
    const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(response.status).toBe(500)
    expect(tables.stripe_connect_payouts[0].admin_alert_status).toBe('failed')
    expect(tables.stripe_connect_events[0].status).toBe('failed')
  })

  it('a genuinely missing ADMIN_ALERT_EMAIL at the very first claim is recorded as a failure without ever reaching sendPayoutFailedAdminAlertOrThrow', async () => {
    const original = process.env.ADMIN_ALERT_EMAIL
    delete process.env.ADMIN_ALERT_EMAIL
    try {
      payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
      const response = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
      expect(response.status).toBe(500)
      expect(sendPayoutFailedAdminAlertOrThrow).not.toHaveBeenCalled()

      const row = tables.stripe_connect_payouts[0]
      expect(row.admin_alert_status).toBe('failed')
      expect(row.admin_alert_payload_snapshot).toBeNull()
      expect(row.last_alert_error).toMatch(/ADMIN_ALERT_EMAIL/)
    } finally {
      process.env.ADMIN_ALERT_EMAIL = original
    }
  })

  it('Resend accepts the email but the DB write recording "sent" fails — a retry reuses the identical idempotency key and payload (within Resend\'s idempotency window this avoids a second physical send), and eventually corrects the status to sent', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    forceNextSentWriteToFail = true

    const firstResponse = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(firstResponse.status).toBe(500)
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)

    let row = tables.stripe_connect_payouts[0]
    // Resend "succeeded" (our mock returned an id) but the sent-write
    // itself failed, so the catch block's markAdminAlertFailed ran —
    // the row is 'failed', not stuck at 'sending'.
    expect(row.admin_alert_status).toBe('failed')
    expect(row.admin_alert_provider_id).toBeNull()

    const [firstPayload, firstIdempotencyKey] = sendPayoutFailedAdminAlertOrThrow.mock.calls[0]

    const secondResponse = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
    expect(secondResponse.status).toBe(200)
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(2)

    const [secondPayload, secondIdempotencyKey] = sendPayoutFailedAdminAlertOrThrow.mock.calls[1]
    // Identical idempotency key AND identical payload — within Resend's
    // own idempotency window this is what lets it recognize the retry as
    // a duplicate of the already-accepted request instead of sending a
    // second physical email.
    expect(secondPayload).toEqual(firstPayload)
    expect(secondIdempotencyKey).toBe(firstIdempotencyKey)

    row = tables.stripe_connect_payouts[0]
    expect(row.admin_alert_status).toBe('sent')
    expect(row.admin_alert_provider_id).toBe('email-provider-id-1')
  })

  it('a retry sends the byte-for-byte identical payload and idempotency key even after ADMIN_ALERT_EMAIL changes and the "template" would render differently — the frozen snapshot is used, never a fresh build', async () => {
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    sendPayoutFailedAdminAlertOrThrow.mockRejectedValueOnce(new Error('transient send failure'))

    const originalAdminAlertEmail = process.env.ADMIN_ALERT_EMAIL
    const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL
    try {
      const firstResponse = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
      expect(firstResponse.status).toBe(500)
      const [firstPayload, firstIdempotencyKey] = sendPayoutFailedAdminAlertOrThrow.mock.calls[0]
      expect(firstPayload.to).toBe('admin@example.com')

      // Simulate the world changing between the first attempt and the
      // retry — a config edit AND, implicitly, a newer template version:
      // if ensureAdminAlertSent ever re-rendered instead of reusing the
      // frozen snapshot, at least one of these would show up below.
      process.env.ADMIN_ALERT_EMAIL = 'changed-admin@example.com'
      process.env.NEXT_PUBLIC_BASE_URL = 'https://a-completely-different-domain.example'

      const secondResponse = await POST(webhookRequest(payoutEnvelope('evt_1', 'payout.failed', 'acct_agent_1', 'po_1')))
      expect(secondResponse.status).toBe(200)
      const [secondPayload, secondIdempotencyKey] = sendPayoutFailedAdminAlertOrThrow.mock.calls[1]

      expect(secondPayload).toEqual(firstPayload) // byte-for-byte identical
      expect(secondPayload.to).toBe('admin@example.com') // NOT 'changed-admin@example.com'
      expect(secondPayload.html).not.toContain('a-completely-different-domain.example')
      expect(secondIdempotencyKey).toBe(firstIdempotencyKey)
    } finally {
      process.env.ADMIN_ALERT_EMAIL = originalAdminAlertEmail
      process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl
    }
  })
})

describe('claimPayoutAdminAlert — real lease semantics (mirrors claimConnectEvent)', () => {
  function seedPayoutRow(overrides: Row = {}) {
    const row: Row = {
      id: 'payout-row-x',
      stripe_payout_id: 'po_x',
      stripe_account_id: 'acct_agent_1',
      agent_id: AGENT_ID,
      amount_minor: 5000,
      currency: 'eur',
      status: 'failed',
      admin_alert_status: 'pending',
      admin_alert_claim_token: null,
      admin_alert_claimed_at: null,
      admin_alert_sent_at: null,
      admin_alert_attempts: 0,
      admin_alert_payload_snapshot: null,
      admin_alert_provider_id: null,
      last_alert_error: null,
      ...overrides,
    }
    tables.stripe_connect_payouts.push(row)
    return row
  }

  const snapshotA = { from: 'Mercatai <noreply@mercatai.eu>', to: 'admin@example.com', subject: 'Payout failed — 50.00 EUR', html: '<p>50.00 EUR</p>', payloadVersion: 1 }

  it('claim atomically increments admin_alert_attempts on every successful claim, minting a new token each time', async () => {
    const db = makeDb() as any
    const row = seedPayoutRow()

    const first = await claimPayoutAdminAlert(db, row.id, snapshotA)
    expect(first.claimed).toBe(true)
    expect((first as any).attemptCount).toBe(1)

    row.admin_alert_status = 'failed' // a send failed — reclaimable
    const second = await claimPayoutAdminAlert(db, row.id, { ...snapshotA, html: '<p>CHANGED</p>' })
    expect(second.claimed).toBe(true)
    expect((second as any).attemptCount).toBe(2)
    expect((second as any).claimToken).not.toBe((first as any).claimToken)
  })

  it('only ever adopts the payload snapshot from the FIRST successful claim — a later claim\'s candidate is ignored', async () => {
    const db = makeDb() as any
    const row = seedPayoutRow()

    await claimPayoutAdminAlert(db, row.id, snapshotA)
    row.admin_alert_status = 'failed'
    const second = await claimPayoutAdminAlert(db, row.id, { ...snapshotA, html: '<p>CHANGED</p>', subject: 'a different subject' })
    expect((second as any).payloadSnapshot).toEqual(snapshotA)
  })

  it('a fresh "sending" claim (within its lease) is never reclaimed', async () => {
    const db = makeDb() as any
    const row = seedPayoutRow()

    await claimPayoutAdminAlert(db, row.id, snapshotA)
    const second = await claimPayoutAdminAlert(db, row.id, snapshotA)
    expect(second.claimed).toBe(false)
  })

  it('an already-"sent" alert is never reclaimed', async () => {
    const db = makeDb() as any
    const row = seedPayoutRow({ admin_alert_status: 'sent' })
    const claim = await claimPayoutAdminAlert(db, row.id, snapshotA)
    expect(claim.claimed).toBe(false)
  })

  it('two workers crossing the lease boundary: the old worker whose lease expired and was reclaimed can never mark sent or failed for the newer claim — only one delivery is ever recorded', async () => {
    const db = makeDb() as any
    const row = seedPayoutRow()

    const claimA = await claimPayoutAdminAlert(db, row.id, snapshotA)
    expect(claimA.claimed).toBe(true)
    const tokenA = (claimA as any).claimToken

    // Worker A's lease expires (it crashed without finishing).
    row.admin_alert_claimed_at = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    const claimB = await claimPayoutAdminAlert(db, row.id, snapshotA)
    expect(claimB.claimed).toBe(true)
    const tokenB = (claimB as any).claimToken
    expect(tokenB).not.toBe(tokenA)

    // Worker B completes normally — this is the ONE delivery that counts.
    await markAdminAlertSent(db, row.id, tokenB, 'provider-id-b')
    expect(row.admin_alert_status).toBe('sent')

    // Worker A, unaware it was ever reclaimed, tries to record its own
    // (stale) outcome afterward — neither write may succeed or disturb B's result.
    await expect(markAdminAlertSent(db, row.id, tokenA, 'provider-id-a')).rejects.toThrow(/no longer matches/)
    await expect(markAdminAlertFailed(db, row.id, tokenA, 'A thinks it failed')).rejects.toThrow(/no longer matches/)
    expect(row.admin_alert_status).toBe('sent') // untouched by A
    expect(row.admin_alert_provider_id).toBe('provider-id-b')
  })

  it('a database error while claiming is thrown, not returned as a false negative', async () => {
    const db = makeDb() as any
    const row = seedPayoutRow()
    forcedErrors.stripe_connect_payouts = true
    await expect(claimPayoutAdminAlert(db, row.id, snapshotA)).rejects.toThrow(/connection reset/)
  })
})

describe('markAdminAlertSent / markAdminAlertFailed — real Supabase error handling', () => {
  function dbReturning(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: async () => result }) }) }) }),
      }),
    } as any
  }

  it('markAdminAlertSent throws when Supabase returns a real error', async () => {
    const db = dbReturning({ data: null, error: { message: 'connection reset' } })
    await expect(markAdminAlertSent(db, 'row-1', 'token-1', 'provider-1')).rejects.toThrow(/connection reset/)
  })

  it('markAdminAlertFailed throws when Supabase returns a real error', async () => {
    const db = dbReturning({ data: null, error: { message: 'timeout' } })
    await expect(markAdminAlertFailed(db, 'row-1', 'token-1', 'boom')).rejects.toThrow(/timeout/)
  })

  it('markAdminAlertSent throws when zero rows match (a plain try/catch around the caller is not enough — the actual Supabase result must be checked)', async () => {
    const db = dbReturning({ data: [], error: null })
    await expect(markAdminAlertSent(db, 'row-1', 'stale-token', 'provider-1')).rejects.toThrow(/no longer matches/)
  })

  it('markAdminAlertFailed throws when zero rows match', async () => {
    const db = dbReturning({ data: [], error: null })
    await expect(markAdminAlertFailed(db, 'row-1', 'stale-token', 'boom')).rejects.toThrow(/no longer matches/)
  })
})

describe('buildPayoutAlertIdempotencyKey', () => {
  it('is deterministic for the same (stripeAccountId, stripePayoutId) pair', () => {
    expect(buildPayoutAlertIdempotencyKey('acct_1', 'po_1')).toBe(buildPayoutAlertIdempotencyKey('acct_1', 'po_1'))
  })

  it('differs for a different payout or a different account', () => {
    expect(buildPayoutAlertIdempotencyKey('acct_1', 'po_1')).not.toBe(buildPayoutAlertIdempotencyKey('acct_1', 'po_2'))
    expect(buildPayoutAlertIdempotencyKey('acct_1', 'po_1')).not.toBe(buildPayoutAlertIdempotencyKey('acct_2', 'po_1'))
  })

  it('never exceeds Resend\'s 256-character limit, even for pathologically long ids', () => {
    const key = buildPayoutAlertIdempotencyKey('acct_' + 'x'.repeat(500), 'po_' + 'y'.repeat(500))
    expect(key.length).toBeLessThanOrEqual(256)
  })
})

describe('idempotent, lease-based event receipt', () => {
  it('processes a brand-new event exactly once and marks it completed', async () => {
    const response = await POST(webhookRequest(accountUpdatedEvent('evt_once')))
    expect(response.status).toBe(200)
    expect(tables.stripe_connect_events).toHaveLength(1)
    expect(tables.stripe_connect_events[0].status).toBe('completed')
    expect(tables.stripe_connect_events[0].claim_token).toBeTruthy()
  })

  it('redelivery of the exact same event id does not reprocess or duplicate the audit trail', async () => {
    const event = payoutEnvelope('evt_dup', 'payout.failed', 'acct_agent_1', 'po_1')
    payoutStates['po_1'] = defaultPayoutState({ status: 'failed' })
    await POST(webhookRequest(event))
    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)
    const payoutRowsAfterFirst = tables.stripe_connect_payouts.length
    const auditRowsAfterFirst = tables.audit_logs.length

    const secondResponse = await POST(webhookRequest(event))
    expect(secondResponse.status).toBe(200)
    const secondBody = await secondResponse.json()
    expect(secondBody.duplicate).toBe(true)

    expect(sendPayoutFailedAdminAlertOrThrow).toHaveBeenCalledTimes(1)
    expect(tables.stripe_connect_payouts).toHaveLength(payoutRowsAfterFirst)
    expect(tables.audit_logs).toHaveLength(auditRowsAfterFirst)
    expect(tables.stripe_connect_events).toHaveLength(1)
  })

  it('a database error while claiming the event returns 500 so Stripe retries, without partially processing it', async () => {
    forcedErrors.stripe_connect_events = true
    const response = await POST(webhookRequest(payoutEnvelope('evt_dberror', 'payout.paid', 'acct_agent_1', 'po_1')))
    expect(response.status).toBe(500)
    expect(sendPayoutFailedAdminAlertOrThrow).not.toHaveBeenCalled()
    expect(tables.stripe_connect_payouts).toHaveLength(0)
  })

  it('a worker that crashes mid-processing, where marking it failed ALSO fails, leaves the event stuck at processing — not completed, eligible for stale-lease reclaim later', async () => {
    const db = makeDb() as any
    const event = payoutEnvelope('evt_stuck', 'payout.paid', 'acct_agent_1', 'po_1') as any
    const claim = await claimConnectEvent(db, event)
    expect(claim.claimed).toBe(true)
    expect(tables.stripe_connect_events[0].status).toBe('processing')

    // Processing itself fails (simulated directly, rather than via a
    // specific handler) — the important part under test is what happens
    // to the EVENT ROW when the subsequent attempt to record that failure
    // also fails.
    forcedErrors.stripe_connect_events = true
    await expect(markConnectEventFailed(db, (claim as any).id, (claim as any).claimToken, 'processing blew up')).rejects.toThrow()

    expect(tables.stripe_connect_events[0].status).toBe('processing') // neither 'completed' nor 'failed' was ever persisted
  })
})

describe('claimConnectEvent — real lease semantics', () => {
  it('a retry before the lease expires claims nothing (row stays with the original claim_token)', async () => {
    const db = makeDb() as any
    const event = accountUpdatedEvent('evt_lease') as any
    const first = await claimConnectEvent(db, event)
    expect(first.claimed).toBe(true)

    const second = await claimConnectEvent(db, event)
    expect(second.claimed).toBe(false)
    expect(tables.stripe_connect_events[0].claim_token).toBe((first as any).claimToken)
  })

  it('a retry after the lease has expired reclaims the event with a brand-new claim_token', async () => {
    const db = makeDb() as any
    tables.stripe_connect_events.push({
      id: 'evt-row-stale',
      stripe_event_id: 'evt_stale',
      event_type: 'payout.paid',
      stripe_account_id: 'acct_agent_1',
      status: 'processing',
      claim_token: 'old-token',
      processing_started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago, default lease is 5 min
      attempt_count: 1,
      last_error: null,
      completed_at: null,
    })
    const event = { id: 'evt_stale', type: 'payout.paid', account: 'acct_agent_1', data: { object: { id: 'po_1' } } } as any
    const claim = await claimConnectEvent(db, event)
    expect(claim.claimed).toBe(true)
    expect((claim as any).claimToken).not.toBe('old-token')
    expect(tables.stripe_connect_events[0].attempt_count).toBe(2)
  })

  it('a FRESH processing row (within its lease) is never reclaimed', async () => {
    const db = makeDb() as any
    tables.stripe_connect_events.push({
      id: 'evt-row-fresh',
      stripe_event_id: 'evt_fresh',
      event_type: 'payout.paid',
      stripe_account_id: 'acct_agent_1',
      status: 'processing',
      claim_token: 'current-token',
      processing_started_at: new Date().toISOString(),
      attempt_count: 1,
      last_error: null,
      completed_at: null,
    })
    const event = { id: 'evt_fresh', type: 'payout.paid', account: 'acct_agent_1', data: { object: { id: 'po_1' } } } as any
    const claim = await claimConnectEvent(db, event)
    expect(claim.claimed).toBe(false)
  })

  it('an old worker whose lease expired and was reclaimed can never mark the newer claim completed', async () => {
    const db = makeDb() as any
    const event = accountUpdatedEvent('evt_race') as any
    const firstClaim = await claimConnectEvent(db, event)
    expect(firstClaim.claimed).toBe(true)
    const oldToken = (firstClaim as any).claimToken
    const rowId = (firstClaim as any).id

    // Simulate the first worker's lease expiring, then a second attempt
    // reclaiming the same row.
    tables.stripe_connect_events[0].processing_started_at = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const secondClaim = await claimConnectEvent(db, event)
    expect(secondClaim.claimed).toBe(true)
    expect((secondClaim as any).claimToken).not.toBe(oldToken)

    // The OLD worker, unaware it was reclaimed, tries to complete using
    // its now-stale token.
    await expect(markConnectEventCompleted(db, rowId, oldToken)).rejects.toThrow(/claim_token no longer matches/)
    // The row must still reflect whatever the NEW claim leaves it as —
    // the old worker's completion attempt must not have applied.
    expect(tables.stripe_connect_events[0].status).not.toBe('completed')
  })

  it('a concurrent duplicate claim attempt on a brand-new event lets exactly one caller claim it', async () => {
    const db = makeDb() as any
    const event = payoutEnvelope('evt_concurrent_new', 'payout.paid', 'acct_agent_1', 'po_1') as any
    const [first, second] = await Promise.all([claimConnectEvent(db, event), claimConnectEvent(db, event)])
    const claims = [first, second]
    expect(claims.filter((c) => c.claimed)).toHaveLength(1)
    expect(claims.filter((c) => !c.claimed)).toHaveLength(1)
    expect(tables.stripe_connect_events).toHaveLength(1)
  })
})

describe('markConnectEventCompleted / markConnectEventFailed — real Supabase error handling', () => {
  function dbReturning(result: { data: unknown; error: unknown }) {
    return { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: async () => result }) }) }) }) } as any
  }

  it('markConnectEventCompleted throws when Supabase returns a real error', async () => {
    const db = dbReturning({ data: null, error: { message: 'connection reset' } })
    await expect(markConnectEventCompleted(db, 'row-1', 'token-1')).rejects.toThrow(/connection reset/)
  })

  it('markConnectEventFailed throws when Supabase returns a real error', async () => {
    const db = dbReturning({ data: null, error: { message: 'timeout' } })
    await expect(markConnectEventFailed(db, 'row-1', 'token-1', 'boom')).rejects.toThrow(/timeout/)
  })

  it('markConnectEventCompleted throws when zero rows match (a plain try/catch around the caller is not enough — the actual Supabase result must be checked)', async () => {
    const db = dbReturning({ data: [], error: null })
    await expect(markConnectEventCompleted(db, 'row-1', 'stale-token')).rejects.toThrow(/claim_token no longer matches/)
  })

  it('markConnectEventFailed throws when zero rows match', async () => {
    const db = dbReturning({ data: [], error: null })
    await expect(markConnectEventFailed(db, 'row-1', 'stale-token', 'boom')).rejects.toThrow(/claim_token no longer matches/)
  })
})
