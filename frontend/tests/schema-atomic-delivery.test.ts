import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const migration = readFileSync(join(ROOT, 'frontend', 'sql', '16_atomic_task_delivery.sql'), 'utf-8')
const schema = readFileSync(join(ROOT, 'backend', 'db', 'schema.sql'), 'utf-8')
const compose = readFileSync(join(ROOT, 'deploy', 'docker-compose.yml'), 'utf-8')
const route = readFileSync(join(ROOT, 'frontend', 'app', 'api', 'v1', 'tasks', '[id]', 'deliver', 'route.ts'), 'utf-8')

describe('migration 16 — atomic funded task delivery', () => {
  it('locks and validates the task plus newest transaction before either write', () => {
    expect(migration).toMatch(/FROM tasks t[\s\S]*FOR UPDATE/)
    expect(migration).toMatch(/is_platform_seed\s*=\s*TRUE/)
    expect(migration).toMatch(/archived_at IS NOT NULL/)
    expect(migration).toMatch(/status <> 'in_progress'/)
    expect(migration).toMatch(/ORDER BY tr\.created_at DESC NULLS LAST, tr\.id DESC[\s\S]*FOR UPDATE/)
    expect(migration).toMatch(/v_escrow_status <> 'held'/)
  })

  it('updates the review deadline and task transition inside the same function', () => {
    const functionBody = migration.match(/CREATE OR REPLACE FUNCTION submit_funded_task_delivery[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0]
    expect(functionBody).toBeTruthy()
    expect(functionBody).toMatch(/UPDATE transactions/)
    expect(functionBody).toMatch(/review_deadline_at = v_review_deadline/)
    expect(functionBody).toMatch(/UPDATE tasks/)
    expect(functionBody).toMatch(/status = 'review'/)
    expect(functionBody).toMatch(/delivery_note = BTRIM\(p_delivery_note\)/)
  })

  it('is callable by service_role but not PUBLIC', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION submit_funded_task_delivery\(UUID, UUID, TEXT\) FROM PUBLIC/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION submit_funded_task_delivery\(UUID, UUID, TEXT\) TO service_role/)
  })

  it('keeps the canonical schema in sync and mounts migration 16 after migration 15', () => {
    expect(schema).toContain('CREATE OR REPLACE FUNCTION submit_funded_task_delivery')
    const lines = compose.split('\n')
    const migration15 = lines.findIndex((line) => line.includes('frontend/sql/15_task_archival.sql'))
    const migration16 = lines.findIndex((line) => line.includes('frontend/sql/16_atomic_task_delivery.sql'))
    expect(migration15).toBeGreaterThanOrEqual(0)
    expect(migration16).toBeGreaterThan(migration15)
    expect(lines[migration16]).toMatch(/:\/docker-entrypoint-initdb\.d\/33_atomic_task_delivery\.sql:ro$/)
  })

  it('the API uses only the atomic RPC for delivery writes', () => {
    expect(route).toContain("db.rpc('submit_funded_task_delivery'")
    expect(route).not.toMatch(/\.from\('tasks'\)\s*\.update/)
    expect(route).not.toMatch(/\.from\('transactions'\)\s*\.update/)
  })
})
