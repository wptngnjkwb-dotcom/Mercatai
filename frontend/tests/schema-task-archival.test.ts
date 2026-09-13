import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Reads the actual SQL/compose files from disk — deliberately not an
// application-level mock. The requirement under test ("archival never
// deletes anything", "migration 15 is schema-only") is a property of the
// SQL statements themselves, not of any mocked route, so it can only be
// verified by reading them.
const REPO_ROOT = join(__dirname, '..', '..')
const SCHEMA_SQL = readFileSync(join(REPO_ROOT, 'backend', 'db', 'schema.sql'), 'utf8')
const MIGRATION_15 = readFileSync(join(REPO_ROOT, 'frontend', 'sql', '15_task_archival.sql'), 'utf8')
const MANUAL_ARCHIVE_SCRIPT = readFileSync(join(REPO_ROOT, 'frontend', 'sql', 'manual_archive_demo_tasks.sql'), 'utf8')
const DOCKER_COMPOSE = readFileSync(join(REPO_ROOT, 'deploy', 'docker-compose.yml'), 'utf8')

function extractTableBody(sql: string, tableName: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`)
  expect(start, `CREATE TABLE IF NOT EXISTS ${tableName} not found`).toBeGreaterThan(-1)
  const end = sql.indexOf(');', start)
  expect(end, `closing ');' for ${tableName} not found`).toBeGreaterThan(start)
  return sql.slice(start, end)
}

describe('frontend/sql/15_task_archival.sql is schema-only — no data is touched', () => {
  it('contains no DELETE, TRUNCATE, or DROP TABLE statement anywhere', () => {
    expect(MIGRATION_15).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(MIGRATION_15).not.toMatch(/\bTRUNCATE\b/i)
    expect(MIGRATION_15).not.toMatch(/\bDROP\s+TABLE\b/i)
  })

  it('only ever adds nullable columns to tasks — never drops or alters an existing column', () => {
    expect(MIGRATION_15).toMatch(/ALTER TABLE tasks\s*\n\s*ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/)
    expect(MIGRATION_15).toMatch(/ADD COLUMN IF NOT EXISTS archived_reason TEXT/)
    expect(MIGRATION_15).not.toMatch(/DROP COLUMN/i)
    expect(MIGRATION_15).not.toMatch(/ALTER COLUMN/i)
  })

  it('contains no UPDATE statement — a fresh install\'s own seed/demo tasks must stay visible after this runs', () => {
    expect(MIGRATION_15).not.toMatch(/\bUPDATE\s+tasks\b/i)
    expect(MIGRATION_15).not.toMatch(/\bINSERT\s+INTO\s+audit_logs\b/i)
  })

  it('never mentions demo_cleanup or is_platform_seed — that is the manual script\'s job, not this migration\'s', () => {
    expect(MIGRATION_15).not.toMatch(/demo_cleanup/)
    expect(MIGRATION_15).not.toMatch(/is_platform_seed/)
  })
})

describe('frontend/sql/manual_archive_demo_tasks.sql — manual production-only demo takedown', () => {
  it('contains no DELETE, TRUNCATE, or DROP TABLE statement anywhere', () => {
    expect(MANUAL_ARCHIVE_SCRIPT).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(MANUAL_ARCHIVE_SCRIPT).not.toMatch(/\bTRUNCATE\b/i)
    expect(MANUAL_ARCHIVE_SCRIPT).not.toMatch(/\bDROP\s+TABLE\b/i)
  })

  it('is not mounted anywhere in deploy/docker-compose.yml — it must never auto-run', () => {
    expect(DOCKER_COMPOSE).not.toMatch(/manual_archive_demo_tasks\.sql/)
  })

  it('archives via UPDATE, not by removing rows, and is idempotent (guarded by archived_at IS NULL)', () => {
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/UPDATE tasks t/)
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/SET archived_at = NOW\(\)/)
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/AND t\.archived_at IS NULL/)
  })

  it('scopes archival to BOTH is_platform_seed and moderated_by = system:seed — never the org flag alone', () => {
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/o\.is_platform_seed = true/)
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/t\.moderated_by = 'system:seed'/)
  })

  it('never touches bids, audit_logs (beyond appending), or organizations rows destructively', () => {
    // The only audit_logs interaction is an INSERT (an append, consistent
    // with audit_logs being append-only elsewhere in this schema) — never
    // an UPDATE or DELETE against it. bids and organizations are read
    // (joined) but never written at all by this script.
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/INSERT INTO audit_logs/)
    expect(MANUAL_ARCHIVE_SCRIPT).not.toMatch(/UPDATE (bids|organizations|audit_logs)\b/i)
    expect(MANUAL_ARCHIVE_SCRIPT).not.toMatch(/DELETE FROM (bids|organizations|audit_logs|tasks)\b/i)
  })

  it('documents its own reversal (setting archived_at/archived_reason back to NULL)', () => {
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/archived_at = NULL/)
    expect(MANUAL_ARCHIVE_SCRIPT).toMatch(/archived_reason = NULL/)
  })
})

describe('canonical schema.sql matches the archival columns', () => {
  it('tasks has archived_at and archived_reason, both nullable (no NOT NULL)', () => {
    const body = extractTableBody(SCHEMA_SQL, 'tasks')
    expect(body).toMatch(/archived_at\s+TIMESTAMPTZ/)
    expect(body).toMatch(/archived_reason\s+TEXT/)
    // Neither column has its own NOT NULL — reversibility depends on being
    // able to set archived_at back to NULL.
    expect(body).not.toMatch(/archived_at\s+TIMESTAMPTZ\s+NOT NULL/)
  })

  it('has an index on archived_at for the exclusion filter every read path applies', () => {
    expect(SCHEMA_SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_tasks_archived\s+ON tasks\(archived_at\)/)
  })
})

describe('deploy/docker-compose.yml mounts migration 15 into the db init directory', () => {
  it('mounts frontend/sql/15_task_archival.sql read-only, after migration 14', () => {
    const lines = DOCKER_COMPOSE.split('\n')
    const migration14Index = lines.findIndex((l) => l.includes('frontend/sql/14_stripe_connect_monitoring.sql'))
    const migration15Index = lines.findIndex((l) => l.includes('frontend/sql/15_task_archival.sql'))

    expect(migration14Index).toBeGreaterThan(-1)
    expect(migration15Index).toBeGreaterThan(migration14Index)
    expect(lines[migration15Index]).toMatch(/:\/docker-entrypoint-initdb\.d\/\d+_task_archival\.sql:ro$/)
  })
})
