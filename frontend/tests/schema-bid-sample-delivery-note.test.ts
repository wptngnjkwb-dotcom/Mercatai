import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Reads the actual SQL/compose files from disk — this is deliberately NOT
// an application-level mock test. The bug this guards against (bids.sample_preview
// and tasks.delivery_note existing in production but nowhere in a tracked
// migration or the canonical schema) was invisible to every existing mocked
// route test, since those mocks never modeled a real Postgres schema at
// all — it only surfaced when bidding/delivery were run against a genuinely
// fresh self-hosted database built from these exact files.
const REPO_ROOT = join(__dirname, '..', '..')
const SCHEMA_SQL = readFileSync(join(REPO_ROOT, 'backend', 'db', 'schema.sql'), 'utf8')
const MIGRATION_13 = readFileSync(join(REPO_ROOT, 'frontend', 'sql', '13_bid_sample_and_delivery_note.sql'), 'utf8')
const DOCKER_COMPOSE = readFileSync(join(REPO_ROOT, 'deploy', 'docker-compose.yml'), 'utf8')

/** Extracts the body of a `CREATE TABLE IF NOT EXISTS <name> ( ... );` block from schema.sql, so assertions check the right table and not just "this string appears somewhere in the file". */
function extractTableBody(sql: string, tableName: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`)
  expect(start, `CREATE TABLE IF NOT EXISTS ${tableName} not found in schema.sql`).toBeGreaterThan(-1)
  const end = sql.indexOf(');', start)
  expect(end, `closing ');' for ${tableName} not found in schema.sql`).toBeGreaterThan(start)
  return sql.slice(start, end)
}

describe('canonical schema.sql has the columns the app has always required', () => {
  it('bids table includes sample_preview', () => {
    const bidsBody = extractTableBody(SCHEMA_SQL, 'bids')
    expect(bidsBody).toMatch(/sample_preview\s+TEXT/)
  })

  it('tasks table includes delivery_note', () => {
    const tasksBody = extractTableBody(SCHEMA_SQL, 'tasks')
    expect(tasksBody).toMatch(/delivery_note\s+TEXT/)
  })

  it('does not duplicate sample_preview into auto_bid_rules — that table already has its own, distinct column', () => {
    // auto_bid_rules (and its own, separately-defined sample_preview
    // column) lives entirely in frontend/sql/03_agent_value.sql, not in
    // schema.sql at all — this fix must not have introduced it here, and
    // must not have added a second sample_preview column anywhere in this
    // file beyond the one on bids.
    expect(SCHEMA_SQL).not.toMatch(/CREATE TABLE IF NOT EXISTS auto_bid_rules/)
    const occurrences = (SCHEMA_SQL.match(/sample_preview/g) || []).length
    expect(occurrences).toBe(1)
  })
})

describe('frontend/sql/13_bid_sample_and_delivery_note.sql is idempotent and complete', () => {
  it('adds bids.sample_preview with IF NOT EXISTS', () => {
    expect(MIGRATION_13).toMatch(/ALTER TABLE bids\s+ADD COLUMN IF NOT EXISTS sample_preview TEXT/)
  })

  it('adds tasks.delivery_note with IF NOT EXISTS', () => {
    expect(MIGRATION_13).toMatch(/ALTER TABLE tasks\s+ADD COLUMN IF NOT EXISTS delivery_note TEXT/)
  })
})

describe('deploy/docker-compose.yml mounts migration 13 into the db init directory', () => {
  it('mounts frontend/sql/13_bid_sample_and_delivery_note.sql read-only, after migration 12', () => {
    const lines = DOCKER_COMPOSE.split('\n')
    const migration12Index = lines.findIndex((l) => l.includes('frontend/sql/12_agent_profile_visibility.sql'))
    const migration13Index = lines.findIndex((l) => l.includes('frontend/sql/13_bid_sample_and_delivery_note.sql'))

    expect(migration12Index).toBeGreaterThan(-1)
    expect(migration13Index).toBeGreaterThan(migration12Index)
    expect(lines[migration13Index]).toMatch(/:\/docker-entrypoint-initdb\.d\/\d+_bid_sample_and_delivery_note\.sql:ro$/)
  })
})
