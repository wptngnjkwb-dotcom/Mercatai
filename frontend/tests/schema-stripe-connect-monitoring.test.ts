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

describe('canonical schema.sql has the Stripe Connect monitoring tables', () => {
  it('defines stripe_connect_events with a UNIQUE stripe_event_id and a processing/completed/failed status', () => {
    const body = extractTableBody(SCHEMA_SQL, 'stripe_connect_events')
    expect(body).toMatch(/stripe_event_id\s+TEXT NOT NULL UNIQUE/)
    expect(body).toMatch(/CHECK \(status IN \('processing', 'completed', 'failed'\)\)/)
  })

  it('defines stripe_connect_payouts with a nullable agent_id and a (stripe_account_id, stripe_payout_id) unique pair', () => {
    const body = extractTableBody(SCHEMA_SQL, 'stripe_connect_payouts')
    expect(body).toMatch(/agent_id\s+UUID REFERENCES agents\(id\) ON DELETE SET NULL/)
    expect(body).toMatch(/UNIQUE \(stripe_account_id, stripe_payout_id\)/)
    expect(body).toMatch(/CHECK \(status IN \('pending', 'in_transit', 'paid', 'failed', 'canceled'\)\)/)
  })

  it('never stores a bank account number or account holder name column', () => {
    const body = extractTableBody(SCHEMA_SQL, 'stripe_connect_payouts')
    expect(body).not.toMatch(/account_holder|bank_account|iban|routing_number/i)
  })

  it('does not give stripe_connect_payouts a task_id or transaction_id column — a payout can bundle many transactions', () => {
    const body = extractTableBody(SCHEMA_SQL, 'stripe_connect_payouts')
    expect(body).not.toMatch(/task_id|transaction_id/)
  })

  it('enables row level security and a service_role policy for both new tables', () => {
    expect(SCHEMA_SQL).toMatch(/ALTER TABLE stripe_connect_events\s+ENABLE ROW LEVEL SECURITY/)
    expect(SCHEMA_SQL).toMatch(/ALTER TABLE stripe_connect_payouts\s+ENABLE ROW LEVEL SECURITY/)
    expect(SCHEMA_SQL).toMatch(/CREATE POLICY "service_role_all" ON stripe_connect_events/)
    expect(SCHEMA_SQL).toMatch(/CREATE POLICY "service_role_all" ON stripe_connect_payouts/)
  })
})

describe('frontend/sql/14_stripe_connect_monitoring.sql is idempotent and matches the canonical schema', () => {
  it('uses CREATE TABLE IF NOT EXISTS for both tables', () => {
    expect(MIGRATION_14).toMatch(/CREATE TABLE IF NOT EXISTS stripe_connect_events/)
    expect(MIGRATION_14).toMatch(/CREATE TABLE IF NOT EXISTS stripe_connect_payouts/)
  })

  it('drops and recreates its RLS policies idempotently', () => {
    expect(MIGRATION_14).toMatch(/DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_events/)
    expect(MIGRATION_14).toMatch(/DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_payouts/)
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
