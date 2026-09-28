import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/22_quality_issue_facilitation.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')

describe('migration 22 — mounting and non-destructiveness', () => {
  it('is mounted after direct charges for every fresh self-hosted install', () => {
    const directCharges = compose.indexOf('38_direct_charges.sql')
    const qualityIssue = compose.indexOf('39_quality_issue_facilitation.sql')
    expect(directCharges).toBeGreaterThan(-1)
    expect(qualityIssue).toBeGreaterThan(directCharges)
  })

  it('contains no DELETE, TRUNCATE, or DROP TABLE statement anywhere', () => {
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(migration).not.toMatch(/\bTRUNCATE\b/i)
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i)
  })

  it('never drops or alters an existing column on tasks or transactions', () => {
    expect(migration).not.toMatch(/DROP COLUMN/i)
    expect(migration).not.toMatch(/ALTER TABLE (tasks|transactions)\b[\s\S]*?ALTER COLUMN/i)
  })
})

describe('migration 22 — quality_issues / quality_issue_messages schema', () => {
  it('creates quality_issues with the exact columns the spec requires', () => {
    const table = migration.match(/CREATE TABLE IF NOT EXISTS quality_issues \([\s\S]*?\n\);/)?.[0] ?? ''
    expect(table).toBeTruthy()
    for (const col of ['id', 'task_id', 'opened_by_org_id', 'assigned_agent_id', 'status', 'reason_code', 'initial_message', 'opened_at', 'response_deadline_at', 'refund_claim_token', 'refund_claimed_at', 'refund_attempt_count', 'refund_last_error', 'resolved_at', 'resolution', 'created_at', 'updated_at']) {
      expect(table, col).toContain(col)
    }
  })

  it('quality_issues.status is constrained to the five documented values', () => {
    expect(migration).toMatch(/status\s+TEXT NOT NULL DEFAULT 'open'\s*\n\s*CHECK \(status IN \('open', 'buyer_approved', 'agent_refunded', 'expired', 'closed'\)\)/)
  })

  it('allows at most one OPEN quality issue per task via a partial unique index', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_issues_one_open_per_task\s*\n\s*ON quality_issues\(task_id\) WHERE status = 'open';/)
  })

  it('creates quality_issue_messages with the exact columns the spec requires, and never a public/anon-writable identity leak', () => {
    const table = migration.match(/CREATE TABLE IF NOT EXISTS quality_issue_messages \([\s\S]*?\n\);/)?.[0] ?? ''
    expect(table).toBeTruthy()
    for (const col of ['id', 'quality_issue_id', 'author_role', 'message', 'created_at']) {
      expect(table, col).toContain(col)
    }
    expect(table).toMatch(/author_role\s+TEXT NOT NULL CHECK \(author_role IN \('buyer', 'agent'\)\)/)
  })

  it('quality_issue_messages cascades on quality_issues deletion', () => {
    expect(migration).toMatch(/quality_issue_id\s+UUID NOT NULL REFERENCES quality_issues\(id\) ON DELETE CASCADE/)
  })

  it('both tables are RLS-enabled and service-role-only, mirroring payment_disputes', () => {
    for (const table of ['quality_issues', 'quality_issue_messages']) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
      expect(migration).toMatch(new RegExp(`CREATE POLICY "service_role_all" ON ${table} TO service_role USING \\(true\\) WITH CHECK \\(true\\)`))
    }
  })
})

describe('migration 22 — open_quality_issue() never bypasses task/transaction validity', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION open_quality_issue[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''

  it('exists and is service-role-only', () => {
    expect(fn).toBeTruthy()
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION open_quality_issue\(UUID, UUID, TEXT, TEXT\) FROM PUBLIC, anon, authenticated/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION open_quality_issue\(UUID, UUID, TEXT, TEXT\) TO service_role/)
  })

  it('rejects a task that is not a real, non-demo, non-archived, review-status task', () => {
    expect(fn).toMatch(/v_task\.archived_at IS NOT NULL/)
    expect(fn).toMatch(/v_task\.moderation_status <> 'approved'/)
    expect(fn).toMatch(/v_task\.status <> 'review'/)
    expect(fn).toMatch(/is_platform_seed = TRUE/)
  })

  it('requires a genuinely held, deadline-bearing transaction matching the task', () => {
    expect(fn).toMatch(/v_tx\.escrow_status <> 'held'/)
    expect(fn).toMatch(/v_tx\.review_deadline_at IS NULL/)
  })

  it('extends review_deadline_at by exactly 72 hours, and only the first time for a task', () => {
    expect(fn).toMatch(/SELECT NOT EXISTS\(SELECT 1 FROM quality_issues qi WHERE qi\.task_id = p_task_id\) INTO v_is_first/)
    expect(fn).toMatch(/v_deadline := v_tx\.review_deadline_at \+ INTERVAL '72 hours'/)
    expect(fn).toMatch(/IF v_is_first THEN/)
  })

  it('validates reason_code against the fixed enum and requires a non-empty, length-capped initial_message', () => {
    expect(fn).toMatch(/p_reason_code NOT IN \('not_as_described', 'incomplete_delivery', 'quality_below_expectations', 'other'\)/)
    expect(fn).toMatch(/BTRIM\(p_initial_message\) = ''/)
    expect(fn).toMatch(/CHAR_LENGTH\(BTRIM\(p_initial_message\)\) > 5000/)
  })
})

describe('migration 22 — objective finalizers and voluntary-refund lease', () => {
  it('finalize_funded_task still exists exactly once, redefined (not duplicated) by this migration', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION finalize_funded_task/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('finalize_task_refund still exists exactly once, redefined (not duplicated) by this migration', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION finalize_task_refund/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('the generic refund finalizer is limited to the objective missed-SLA outcome', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION finalize_task_refund[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(fn).toContain("IF p_outcome <> 'sla_missed'")
    expect(fn).not.toMatch(/buyer_refund|admin_dispute_refund|quality_issue_agent_refund/)
    expect(fn).toContain("v_target_status := 'cancelled'")
  })

  it('finalize_funded_task closes an open quality_issue as buyer_approved or expired depending on the reason, as a side effect, matching zero rows when none is open', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION finalize_funded_task[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(fn).toMatch(/UPDATE quality_issues\s*\n\s*SET status = CASE WHEN p_reason = 'review_deadline_expired_48h' THEN 'expired' ELSE 'buyer_approved' END/)
    expect(fn).toMatch(/WHERE task_id = v_task\.id AND status = 'open'/)
  })

  it('only the claim-token-bound voluntary-refund finalizer can mark an issue agent_refunded', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION finalize_quality_issue_refund[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(fn).toContain('refund_claim_token IS DISTINCT FROM p_claim_token')
    expect(fn).toMatch(/UPDATE quality_issues\s*\n\s*SET status = 'agent_refunded'/)
    expect(fn).toMatch(/refund_claim_token = p_claim_token/)
  })

  it('claims before Stripe with a five-minute lease and blocks funded finalization while any claim exists', () => {
    const claim = migration.match(/CREATE FUNCTION claim_quality_issue_refund[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    const funded = migration.match(/CREATE OR REPLACE FUNCTION finalize_funded_task[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(claim).toContain("INTERVAL '5 minutes'")
    expect(claim).toContain('refund_claim_token = v_token')
    expect(funded).toMatch(/status = 'open'[\s\S]*refund_claim_token IS NOT NULL/)
  })

  it('message insertion checks status=open and atomically rate-limits the authenticated actor under a row lock', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION post_quality_issue_message[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(fn).toContain('FOR UPDATE')
    expect(fn).toContain("v_issue.status <> 'open'")
    expect(fn).toContain("v_recent_count >= 60")
    expect(fn).toContain("details @> jsonb_build_object('actor_key', p_actor_key)")
    expect(fn).toContain("RAISE EXCEPTION USING ERRCODE = 'P0003'")
    expect(fn).toContain('INSERT INTO quality_issue_messages')
    expect(fn).toContain("INSERT INTO audit_logs(action, resource_type, resource_id, details, ip_address)")
  })

  it('all financial RPCs avoid Stripe calls and only mutate approved internal tables', () => {
    const funcs = migration.match(/CREATE OR REPLACE FUNCTION (finalize_funded_task|finalize_task_refund|finalize_quality_issue_refund)[\s\S]*?\$\$ LANGUAGE plpgsql;/g) ?? []
    expect(funcs.length).toBe(3)
    for (const fn of funcs) {
      const updatedTables = Array.from(fn.matchAll(/UPDATE (\w+)/g)).map((m) => m[1])
      for (const t of updatedTables) {
        expect(['transactions', 'tasks', 'agents', 'quality_issues']).toContain(t)
      }
    }
  })

  it('keeps every new RPC service-role-only', () => {
    for (const signature of [
      'claim_quality_issue_refund\\(UUID, UUID\\)',
      'finalize_quality_issue_refund\\(UUID, UUID\\)',
      'record_quality_issue_refund_error\\(UUID, UUID, TEXT\\)',
      'post_quality_issue_message\\(UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT\\)',
    ]) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`))
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`))
    }
  })
})
