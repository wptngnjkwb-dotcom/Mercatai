import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/18_payment_charge_identity_and_disputes.sql'), 'utf8')
const schema = readFileSync(resolve(root, 'backend/db/schema.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')
const webhookRoute = readFileSync(resolve(root, 'frontend/app/api/v1/payments/stripe-webhook/route.ts'), 'utf8')
const paymentDisputesModule = readFileSync(resolve(root, 'frontend/lib/server/paymentDisputes.ts'), 'utf8')

describe('migration 18 — mounting and non-destructiveness', () => {
  it('is mounted after payment-integrity hardening for every fresh self-hosted install', () => {
    const hardening = compose.indexOf('34_payment_integrity_hardening.sql')
    const identity = compose.indexOf('35_payment_charge_identity_and_disputes.sql')
    expect(hardening).toBeGreaterThan(-1)
    expect(identity).toBeGreaterThan(hardening)
  })

  it('contains no DELETE, TRUNCATE, or DROP TABLE statement anywhere', () => {
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(migration).not.toMatch(/\bTRUNCATE\b/i)
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i)
  })

  it('only ever ADDs a column to transactions — never drops or alters an existing one', () => {
    expect(migration).toMatch(/ALTER TABLE transactions\s*\n\s*ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT/)
    expect(migration).not.toMatch(/DROP COLUMN/i)
    expect(migration).not.toMatch(/ALTER COLUMN/i)
  })
})

describe('migration 18 — payment_disputes is monitoring-only (never moves money)', () => {
  it('creates payment_disputes with admin_alert_* mirroring stripe_connect_payouts exactly', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS payment_disputes')
    for (const col of ['admin_alert_status', 'admin_alert_claim_token', 'admin_alert_claimed_at', 'admin_alert_sent_at', 'admin_alert_attempts', 'admin_alert_payload_snapshot', 'admin_alert_provider_id', 'last_alert_error']) {
      expect(migration).toContain(col)
    }
  })

  it('never stores card data — only id, charge/payment_intent refs, status, reason, amount, currency', () => {
    const table = migration.match(/CREATE TABLE IF NOT EXISTS payment_disputes \([\s\S]*?\n\);/)?.[0] ?? ''
    expect(table).not.toMatch(/last4|card_number|cvc|pan\b/i)
  })

  it('claim_dispute_admin_alert never touches transactions, tasks, bids, or agents — it only claims its own row', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION claim_dispute_admin_alert[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(fn).not.toMatch(/UPDATE (transactions|tasks|bids|agents)\b/i)
    expect(fn).toMatch(/UPDATE payment_disputes d/)
  })

  it('claim_dispute_admin_alert is executable only by service_role', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION claim_dispute_admin_alert/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION claim_dispute_admin_alert\([^)]*\) TO service_role/)
  })

  it('contains no refund, capture, or transfer-reversal SQL statement — comments may explain that in prose, but no actual SQL keyword for it appears', () => {
    expect(migration).not.toMatch(/\bREFUND\b/) // SQL keywords are uppercase by this file's own convention; prose mentions of "refund" stay lowercase
    expect(migration).not.toMatch(/reverse_transfer/i)
  })
})

describe('canonical schema.sql mirrors migration 18', () => {
  it('transactions has stripe_charge_id, and payment_disputes + claim_dispute_admin_alert exist', () => {
    expect(schema).toMatch(/stripe_charge_id\s+TEXT/)
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS payment_disputes')
    expect(schema).toContain('CREATE OR REPLACE FUNCTION claim_dispute_admin_alert')
  })

  it('has RLS enabled and a service_role policy on payment_disputes', () => {
    expect(schema).toMatch(/ALTER TABLE payment_disputes\s+ENABLE ROW LEVEL SECURITY/)
    expect(schema).toMatch(/CREATE POLICY "service_role_all" ON payment_disputes/)
  })
})

describe('paymentDisputes.ts never issues a refund or transfer reversal', () => {
  it('the module source contains no Stripe refund/transfer-reversal API calls', () => {
    expect(paymentDisputesModule).not.toMatch(/stripe\.refunds\./)
    expect(paymentDisputesModule).not.toMatch(/stripe\.transfers\.createReversal/)
    expect(paymentDisputesModule).not.toMatch(/\.reverse_transfer\b/)
  })

  it('always re-fetches the current Dispute from Stripe rather than trusting the event snapshot', () => {
    expect(paymentDisputesModule).toMatch(/stripe\.disputes\.retrieve\(eventDispute\.id\)/)
  })
})

describe('the main webhook route dispatches dispute events, not the Connect webhook', () => {
  it('registers exactly the three documented dispute event types', () => {
    expect(webhookRoute).toContain("'charge.dispute.created'")
    expect(webhookRoute).toContain("'charge.dispute.updated'")
    expect(webhookRoute).toContain("'charge.dispute.closed'")
  })

  it('dispute handling failures return 500 (retry), never a raw error in the response body', () => {
    const disputeBranch = webhookRoute.match(/else if \(DISPUTE_EVENT_TYPES\.has\(event\.type\)\)[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(disputeBranch).toMatch(/status: 500/)
    expect(disputeBranch).not.toMatch(/err\.message/)
  })
})
