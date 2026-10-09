import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const migration = readFileSync(join(ROOT, 'frontend/sql/25_restore_transaction_pending_states.sql'), 'utf8')
const schema = readFileSync(join(ROOT, 'backend/db/schema.sql'), 'utf8')
const compose = readFileSync(join(ROOT, 'deploy/docker-compose.yml'), 'utf8')

const requiredStates = ['pending', 'held', 'released', 'refunded', 'disputed', 'failed']

describe('migration 25 — restore the complete transaction state machine', () => {
  it('replaces the stale named constraint and keeps pending as the default', () => {
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS transactions_escrow_status_check/)
    expect(migration).toMatch(/ALTER COLUMN escrow_status SET DEFAULT 'pending'/)
    expect(migration).toMatch(/ADD CONSTRAINT transactions_escrow_status_check/)
    expect(migration).toMatch(/VALIDATE CONSTRAINT transactions_escrow_status_check/)
  })

  it('allows every application transaction state in migration and canonical schema', () => {
    for (const state of requiredStates) {
      expect(migration).toContain(`'${state}'`)
      expect(schema).toContain(`'${state}'`)
    }
  })

  it('is mounted after migration 24 for fresh self-hosted installs', () => {
    const lines = compose.split('\n')
    const previous = lines.findIndex((line) => line.includes('24_standard_accounts_and_pilot_express.sql'))
    const current = lines.findIndex((line) => line.includes('25_restore_transaction_pending_states.sql'))
    expect(previous).toBeGreaterThan(-1)
    expect(current).toBeGreaterThan(previous)
  })
})
