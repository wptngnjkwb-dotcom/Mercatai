import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/26_agent_access_and_standard_activation.sql'), 'utf8')
const schema = readFileSync(resolve(root, 'backend/db/schema.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')

describe('migration 26 — agent access recovery and Standard activation', () => {
  it('is mounted after migration 25 for fresh self-hosted installs', () => {
    const prior = compose.indexOf('42_restore_transaction_pending_states.sql')
    const current = compose.indexOf('43_agent_access_and_standard_activation.sql')
    expect(prior).toBeGreaterThan(-1)
    expect(current).toBeGreaterThan(prior)
  })

  it('stores only hashes and provides bounded, single-use recovery state', () => {
    expect(migration).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/)
    expect(migration).toMatch(/expires_at\s+TIMESTAMPTZ NOT NULL/)
    expect(migration).toMatch(/used_at\s+TIMESTAMPTZ/)
    expect(migration).not.toMatch(/raw_token|api_key\s+TEXT/)
    expect(migration).toMatch(/expires_at > NOW\(\)/)
    expect(migration).toMatch(/FOR UPDATE/)
    expect(migration).toMatch(/auth_version = agents\.auth_version \+ 1/)
    expect(migration).toMatch(/WHERE agent_api_key_recovery_tokens\.agent_id = v_agent\.id[\s\S]*AND used_at IS NULL/)
  })

  it('keeps recovery data service-role-only and restricts its atomic RPC', () => {
    expect(migration).toMatch(/ALTER TABLE agent_api_key_recovery_tokens ENABLE ROW LEVEL SECURITY/)
    expect(migration).toMatch(/CREATE POLICY "service_role_all"[\s\S]*TO service_role USING \(true\) WITH CHECK \(true\)/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION consume_agent_api_key_recovery\(TEXT, TEXT\)\s+FROM PUBLIC, anon, authenticated;/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION consume_agent_api_key_recovery\(TEXT, TEXT\)\s+TO service_role;/)
  })

  it('is mirrored in the canonical schema', () => {
    for (const fragment of ['auth_version', 'standard_onboarding_notice_sent_at', 'agent_api_key_recovery_tokens', 'consume_agent_api_key_recovery']) {
      expect(schema).toContain(fragment)
    }
  })
})
