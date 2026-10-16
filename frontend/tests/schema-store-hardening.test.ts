import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/27_store_hardening.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')
const publicFields = readFileSync(resolve(root, 'frontend/lib/server/publicTaskFields.ts'), 'utf8')
const reviewsRoute = readFileSync(resolve(root, 'frontend/app/api/v1/reviews/route.ts'), 'utf8')
const publicAgentReviewsRoute = readFileSync(resolve(root, 'frontend/app/api/v1/agents/[id]/reviews/route.ts'), 'utf8')

describe('migration 27 — Agent Store hardening', () => {
  it('runs after agent-access migration on fresh self-hosted installs', () => {
    const previous = compose.indexOf('43_agent_access_and_standard_activation.sql')
    const current = compose.indexOf('44_store_hardening.sql')
    expect(previous).toBeGreaterThan(-1)
    expect(current).toBeGreaterThan(previous)
  })

  it('adds explicit listing moderation/lifecycle and private task provenance', () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'")
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved'")
    expect(migration).toContain('agent_listings_active_state_check')
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public'")
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'marketplace'")
    expect(migration).toContain('tasks_private_target_check')
    expect(migration).toContain('tasks_store_source_check')
  })

  it('stores idempotency records behind RLS and service-role-only access', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS store_hire_requests')
    expect(migration).toContain('UNIQUE (listing_id, idempotency_key)')
    expect(migration).toContain('ALTER TABLE store_hire_requests ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('REVOKE ALL ON TABLE store_hire_requests FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE store_hire_requests TO service_role')
    expect(migration).toContain('funded_at TIMESTAMPTZ')
  })

  it('serializes duplicate hires and replays the original private task', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION create_store_hire\([\s\S]*?\$\$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;/)?.[0] ?? ''
    expect(fn).toContain('pg_advisory_xact_lock')
    expect(fn).toContain('request_fingerprint IS DISTINCT FROM p_request_fingerprint')
    expect(fn).toContain('v_existing.task_id')
    expect(fn).toContain('FALSE')
    expect(fn).toContain("'standard_agent_liability', 'private', 'store'")
    expect(fn).toContain('v_listing.moderation_status <> \'approved\'')
    expect(fn).toContain('v_agent.profile_visibility <> \'public\'')
    expect(fn).toContain('INSERT INTO store_hire_requests')
    expect(fn).toContain('created_new BOOLEAN')
    expect(fn).not.toContain('SET hires_count = hires_count + 1')
  })

  it('counts Store popularity only after confirmed funding and idempotently', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION record_store_hire_funded\([\s\S]*?\$\$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;/)?.[0] ?? ''
    expect(fn).toContain('v_tx.escrow_status NOT IN (\'held\', \'released\')')
    expect(fn).toContain('v_request.funded_at IS NOT NULL')
    expect(fn.indexOf('v_request.funded_at IS NOT NULL')).toBeLessThan(fn.indexOf('v_tx.escrow_status NOT IN'))
    expect(fn).toContain('SET hires_count = hires_count + 1')
    expect(fn).toContain("VALUES ('store_hire_funded'")
    expect(migration).toContain('REVOKE ALL ON FUNCTION record_store_hire_funded(UUID, UUID)')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION record_store_hire_funded(UUID, UUID) TO service_role')
  })

  it('does not overwrite an already-moderated listing when the migration is rerun', () => {
    expect(migration).toContain('WHERE moderated_at IS NULL;')
  })

  it('keeps the idempotent RPC unavailable to public database roles', () => {
    const signature = 'create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT, TEXT)'
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature}`)
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`)
  })

  it('labels the controlled canary and excludes internal pilots from public outcomes', () => {
    expect(migration).toContain("source = 'internal_pilot'")
    expect(migration).toContain("'ddf5de51-7e06-473c-8a64-d360eef1de55'::uuid")
    expect(migration).toContain("'e427ab6c-62fa-473f-8e84-93003b13a47f'::uuid")
    expect(migration).toContain("'49a315bc-70ea-409d-b46d-d60ac369e23a'::uuid")
    expect(migration).toContain("'2ee876c6-ebc7-489e-b138-306ecdb32eaf'::uuid")
    expect(publicFields).toContain("sourceByTask.get(taskId) === 'internal_pilot'")
    expect(reviewsRoute).toContain("task.source === 'internal_pilot'")
  })

  it('does not expose a private task UUID through public agent reviews', () => {
    expect(publicAgentReviewsRoute).toContain(".select('id, rating, text, created_at')")
    expect(publicAgentReviewsRoute).not.toContain(".select('id, task_id, rating, text, created_at')")
  })
})
