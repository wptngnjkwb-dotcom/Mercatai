import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/19_restrict_service_role_rpcs.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')

const signatures = [
  'claim_stripe_connect_event\\(TEXT, TEXT, TEXT, INTEGER\\)',
  'claim_payout_admin_alert\\(UUID, INTEGER, JSONB\\)',
  'accept_task_bid\\(UUID, UUID\\)',
  'claim_task_payment\\(UUID, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC\\)',
  'submit_funded_task_delivery\\(UUID, UUID, TEXT\\)',
  'invalidate_task_funding\\(UUID, UUID\\)',
  'finalize_funded_task\\(UUID, UUID, TEXT\\)',
  'create_store_hire\\(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT\\[\\], TEXT\\)',
  'finalize_task_refund\\(UUID, UUID, TEXT, TEXT\\)',
  'claim_dispute_admin_alert\\(UUID, INTEGER, JSONB\\)',
]

describe('migration 19 — internal RPC access', () => {
  it('is mounted after migration 18 for fresh self-hosted installs', () => {
    const disputes = compose.indexOf('35_payment_charge_identity_and_disputes.sql')
    const access = compose.indexOf('36_restrict_service_role_rpcs.sql')
    expect(disputes).toBeGreaterThan(-1)
    expect(access).toBeGreaterThan(disputes)
  })

  it.each(signatures)('revokes PUBLIC, anon and authenticated from %s', (signature) => {
    expect(migration).toMatch(new RegExp(
      `REVOKE ALL ON FUNCTION ${signature}\\s+FROM PUBLIC, anon, authenticated;`,
      'm',
    ))
  })

  it.each(signatures)('grants only service_role execution to %s', (signature) => {
    expect(migration).toMatch(new RegExp(
      `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`,
      'm',
    ))
  })

  it('contains no data mutation or destructive schema statement', () => {
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i)
  })
})
