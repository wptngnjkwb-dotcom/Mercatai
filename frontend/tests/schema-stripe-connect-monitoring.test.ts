import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Reads the actual SQL/compose files from disk — deliberately not an
// application-level mock. A route test can fully mock away the database
// and still pass on a schema that would 500 on a real Postgres instance;
// this is what would have caught the bids.sample_preview /
// tasks.delivery_note gap sooner, and is the same shape of test as
// schema-bid-sample-delivery-note.test.ts for that earlier migration.
const REPO_ROOT = join(__dirname, '..', '..')
const SCHEMA_SQL = readFileSync(join(REPO_ROOT, 'backend', 'db', 'schema.sql'), 'utf8')
const MIGRATION_14 = readFileSync(join(REPO_ROOT, 'frontend', 'sql', '14_stripe_connect_monitoring.sql'), 'utf8')
const DOCKER_COMPOSE = readFileSync(join(REPO_ROOT, 'deploy', 'docker-compose.yml'), 'utf8')
const ENV_EXAMPLE = readFileSync(join(REPO_ROOT, 'deploy', '.env.example'), 'utf8')

function extractTableBody(sql: string, tableName: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`)
  expect(start, `CREATE TABLE IF NOT EXISTS ${tableName} not found`).toBeGreaterThan(-1)
  const end = sql.indexOf(');', start)
  expect(end, `closing ');' for ${tableName} not found`).toBeGreaterThan(start)
  return sql.slice(start, end)
}

for (const [label, SQL] of [['canonical schema.sql', SCHEMA_SQL], ['frontend/sql/14_stripe_connect_monitoring.sql', MIGRATION_14]] as const) {
  describe(`${label} — stripe_connect_events is a real lease, not a permanent lock`, () => {
    it('has claim_token, processing_started_at, attempt_count, and last_error columns', () => {
      const body = extractTableBody(SQL, 'stripe_connect_events')
      expect(body).toMatch(/claim_token\s+UUID NOT NULL/)
      expect(body).toMatch(/processing_started_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/)
      expect(body).toMatch(/attempt_count\s+INTEGER NOT NULL DEFAULT 1/)
      expect(body).toMatch(/last_error\s+TEXT/)
      expect(body).toMatch(/stripe_event_id\s+TEXT NOT NULL UNIQUE/)
      expect(body).toMatch(/CHECK \(status IN \('processing', 'completed', 'failed'\)\)/)
    })

    it('defines claim_stripe_connect_event with a stale-lease reclaim branch, never reclaiming a fresh processing row', () => {
      const start = SQL.indexOf('CREATE OR REPLACE FUNCTION claim_stripe_connect_event(')
      expect(start, 'claim_stripe_connect_event function not found').toBeGreaterThan(-1)
      const end = SQL.indexOf('$$ LANGUAGE plpgsql;', start)
      const body = SQL.slice(start, end)
      expect(body).toMatch(/ON CONFLICT \(stripe_event_id\) DO NOTHING/)
      expect(body).toMatch(/e\.status = 'failed'/)
      expect(body).toMatch(/e\.processing_started_at < NOW\(\) - \(p_lease_seconds \|\| ' seconds'\)::interval/)
      expect(body).toMatch(/claim_token = v_token/)
      expect(body).toMatch(/attempt_count = e\.attempt_count \+ 1/)
    })
  })

  describe(`${label} — stripe_connect_payouts stores minor-unit amounts and tracks a reliable admin-alert claim`, () => {
    it('has amount_minor BIGINT (never a pre-divided decimal) and currency', () => {
      const body = extractTableBody(SQL, 'stripe_connect_payouts')
      expect(body).toMatch(/amount_minor\s+BIGINT NOT NULL/)
      expect(body).toMatch(/currency\s+TEXT NOT NULL/)
      expect(body).not.toMatch(/DECIMAL\(12,\s*2\)/)
    })

    it('has admin_alert_status/claim_token/claimed_at/sent_at/attempts/payload_snapshot/provider_id/last_alert_error', () => {
      const body = extractTableBody(SQL, 'stripe_connect_payouts')
      expect(body).toMatch(/admin_alert_status\s+TEXT NOT NULL DEFAULT 'pending'/)
      expect(body).toMatch(/CHECK \(admin_alert_status IN \('pending', 'sending', 'sent', 'failed'\)\)/)
      expect(body).toMatch(/admin_alert_claim_token\s+UUID/)
      expect(body).toMatch(/admin_alert_claimed_at\s+TIMESTAMPTZ/)
      expect(body).toMatch(/admin_alert_sent_at\s+TIMESTAMPTZ/)
      expect(body).toMatch(/admin_alert_attempts\s+INTEGER NOT NULL DEFAULT 0/)
      expect(body).toMatch(/admin_alert_payload_snapshot\s+JSONB/)
      expect(body).toMatch(/admin_alert_provider_id\s+TEXT/)
      expect(body).toMatch(/last_alert_error\s+TEXT/)
    })

    it('has a nullable agent_id and a (stripe_account_id, stripe_payout_id) unique pair', () => {
      const body = extractTableBody(SQL, 'stripe_connect_payouts')
      expect(body).toMatch(/agent_id\s+UUID REFERENCES agents\(id\) ON DELETE SET NULL/)
      expect(body).toMatch(/UNIQUE \(stripe_account_id, stripe_payout_id\)/)
      expect(body).toMatch(/CHECK \(status IN \('pending', 'in_transit', 'paid', 'failed', 'canceled'\)\)/)
    })

    it('never stores a bank account number, account holder name, or IBAN/routing number column', () => {
      const body = extractTableBody(SQL, 'stripe_connect_payouts')
      expect(body).not.toMatch(/account_holder|bank_account|iban|routing_number/i)
    })

    it('does not give stripe_connect_payouts a task_id or transaction_id column — a payout can bundle many transactions', () => {
      const body = extractTableBody(SQL, 'stripe_connect_payouts')
      expect(body).not.toMatch(/task_id|transaction_id/)
    })

    it('defines claim_payout_admin_alert reclaiming pending/failed/stale-sending, never a fresh sending or an already-sent claim', () => {
      const start = SQL.indexOf('CREATE OR REPLACE FUNCTION claim_payout_admin_alert(')
      expect(start, 'claim_payout_admin_alert function not found').toBeGreaterThan(-1)
      const end = SQL.indexOf('$$ LANGUAGE plpgsql;', start)
      const body = SQL.slice(start, end)
      expect(body).toMatch(/admin_alert_status IN \('pending', 'failed'\)/)
      expect(body).toMatch(/admin_alert_status = 'sending' AND p\.admin_alert_claimed_at < NOW\(\)/)
      expect(body).toMatch(/admin_alert_status = 'sending'/)
    })

    it('claim_payout_admin_alert mints a new claim_token, atomically increments admin_alert_attempts, and only adopts a payload snapshot when none exists yet', () => {
      const start = SQL.indexOf('CREATE OR REPLACE FUNCTION claim_payout_admin_alert(')
      const end = SQL.indexOf('$$ LANGUAGE plpgsql;', start)
      const body = SQL.slice(start, end)
      expect(body).toMatch(/p_payload_snapshot JSONB DEFAULT NULL/)
      expect(body).toMatch(/admin_alert_claim_token = v_token/)
      expect(body).toMatch(/admin_alert_attempts = p\.admin_alert_attempts \+ 1/)
      expect(body).toMatch(/admin_alert_payload_snapshot = COALESCE\(p\.admin_alert_payload_snapshot, p_payload_snapshot\)/)
      expect(body).toMatch(/RETURNS TABLE \(claim_token UUID, attempt_count INTEGER, payload_snapshot JSONB\)/)
    })
  })

  describe(`${label} — stripe_connect_account_status is a reliable (non-audit-log) readiness snapshot`, () => {
    it('defines the table with the five readiness fields, not relying on audit_logs', () => {
      const body = extractTableBody(SQL, 'stripe_connect_account_status')
      expect(body).toMatch(/stripe_account_id\s+TEXT PRIMARY KEY/)
      expect(body).toMatch(/charges_enabled\s+BOOLEAN NOT NULL/)
      expect(body).toMatch(/payouts_enabled\s+BOOLEAN NOT NULL/)
      expect(body).toMatch(/card_payments_status\s+TEXT NOT NULL/)
      expect(body).toMatch(/sepa_debit_payments_status\s+TEXT NOT NULL/)
      expect(body).toMatch(/transfers_status\s+TEXT NOT NULL/)
    })
  })

  describe(`${label} — row level security`, () => {
    it('enables RLS and a service_role policy for all three tables', () => {
      for (const table of ['stripe_connect_events', 'stripe_connect_payouts', 'stripe_connect_account_status']) {
        expect(SQL).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`))
        expect(SQL).toMatch(new RegExp(`CREATE POLICY "service_role_all" ON ${table}`))
      }
    })
  })
}

describe('frontend/sql/14_stripe_connect_monitoring.sql is idempotent', () => {
  it('uses CREATE TABLE IF NOT EXISTS for all three tables and CREATE OR REPLACE for both functions', () => {
    expect(MIGRATION_14).toMatch(/CREATE TABLE IF NOT EXISTS stripe_connect_events/)
    expect(MIGRATION_14).toMatch(/CREATE TABLE IF NOT EXISTS stripe_connect_payouts/)
    expect(MIGRATION_14).toMatch(/CREATE TABLE IF NOT EXISTS stripe_connect_account_status/)
    expect(MIGRATION_14).toMatch(/CREATE OR REPLACE FUNCTION claim_stripe_connect_event/)
    expect(MIGRATION_14).toMatch(/CREATE OR REPLACE FUNCTION claim_payout_admin_alert/)
  })

  it('drops and recreates its RLS policies idempotently for all three tables', () => {
    for (const table of ['stripe_connect_events', 'stripe_connect_payouts', 'stripe_connect_account_status']) {
      expect(MIGRATION_14).toMatch(new RegExp(`DROP POLICY IF EXISTS "service_role_all" ON ${table}`))
    }
  })
})

describe('deploy/docker-compose.yml mounts migration 14 into the db init directory', () => {
  it('mounts frontend/sql/14_stripe_connect_monitoring.sql read-only, after migration 13', () => {
    const lines = DOCKER_COMPOSE.split('\n')
    const migration13Index = lines.findIndex((l) => l.includes('frontend/sql/13_bid_sample_and_delivery_note.sql'))
    const migration14Index = lines.findIndex((l) => l.includes('frontend/sql/14_stripe_connect_monitoring.sql'))

    expect(migration13Index).toBeGreaterThan(-1)
    expect(migration14Index).toBeGreaterThan(migration13Index)
    expect(lines[migration14Index]).toMatch(/:\/docker-entrypoint-initdb\.d\/\d+_stripe_connect_monitoring\.sql:ro$/)
  })

  it('passes STRIPE_CONNECT_WEBHOOK_SECRET and ADMIN_ALERT_EMAIL through to the app service', () => {
    expect(DOCKER_COMPOSE).toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET:\s*\$\{STRIPE_CONNECT_WEBHOOK_SECRET/)
    expect(DOCKER_COMPOSE).toMatch(/ADMIN_ALERT_EMAIL:\s*\$\{ADMIN_ALERT_EMAIL/)
  })
})

describe('deploy/.env.example documents the new secrets', () => {
  it('documents STRIPE_CONNECT_WEBHOOK_SECRET as distinct from STRIPE_WEBHOOK_SECRET', () => {
    expect(ENV_EXAMPLE).toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET=/)
    expect(ENV_EXAMPLE).toMatch(/STRIPE_WEBHOOK_SECRET=/)
  })

  it('documents ADMIN_ALERT_EMAIL', () => {
    expect(ENV_EXAMPLE).toMatch(/ADMIN_ALERT_EMAIL=/)
  })
})
