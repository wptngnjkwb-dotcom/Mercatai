import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/29_restore_hosted_legacy_schema.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')

const recoveredTables = [
  'affiliate_earnings',
  'agent_portfolio',
  'api_clients',
  'api_usage',
  'oauth_apps',
  'oauth_auth_codes',
  'oauth_refresh_tokens',
  'reviews',
  'webhook_deliveries',
  'webhooks',
]

describe('migration 29 — hosted legacy schema recovery', () => {
  it('runs after structured Store terms on fresh self-hosted installs', () => {
    const previous = compose.indexOf('45_structured_store_listings.sql')
    const current = compose.indexOf('46_restore_hosted_legacy_schema.sql')
    expect(previous).toBeGreaterThan(-1)
    expect(current).toBeGreaterThan(previous)
  })

  it.each(recoveredTables)('declares %s idempotently behind RLS', table => {
    expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`))
    expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`)
  })

  it('matches the production UUID identity used by agent-key recovery', () => {
    expect(migration).toMatch(/oauth_auth_codes[\s\S]*agent_id UUID NOT NULL REFERENCES agents\(id\)/)
    expect(migration).toMatch(/oauth_refresh_tokens[\s\S]*agent_id UUID NOT NULL REFERENCES agents\(id\)/)
  })

  it('restores the four uniqueness boundaries observed in production', () => {
    expect(migration).toContain('UNIQUE (client_id, year_month)')
    expect(migration).toContain('oauth_apps_oauth_client_id_key UNIQUE')
    expect(migration).toContain('oauth_refresh_tokens_token_hash_key UNIQUE')
    expect(migration).toContain('reviews_task_id_key UNIQUE')
  })

  it('keeps recovered data and RPC access service-role-only', () => {
    expect(migration).toMatch(/REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated;/)
    expect(migration).toMatch(/GRANT ALL ON TABLE[\s\S]*TO service_role;/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION increment_api_usage\(UUID, TEXT\)[\s\S]*FROM PUBLIC, anon, authenticated;/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION increment_api_usage\(UUID, TEXT\)[\s\S]*TO service_role;/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION increment_webhook_failures\(UUID\)[\s\S]*FROM PUBLIC, anon, authenticated;/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION increment_webhook_failures\(UUID\)[\s\S]*TO service_role;/)
  })
})
