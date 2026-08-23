-- 11: Trust & Safety — task moderation.
-- Run in Supabase SQL editor. Idempotent — safe to run repeatedly.
--
-- Adds a moderation lifecycle to `tasks` that is independent of the
-- existing workflow `status` column. A task can be 'open' (workflow) and
-- 'quarantined' (moderation) simultaneously; only 'approved' tasks are
-- ever public, biddable, or surfaced in feeds/webhooks/auto-bid.
--
-- SAFETY: this migration does NOT approve any existing task. Every row
-- currently in `tasks` gets moderation_status = 'pending' by the column
-- default below, which means the public marketplace, task detail, activity
-- feed and bidding all stop showing them the moment the application code
-- from this same change is deployed — until they are explicitly reviewed.
-- See docs/self-hosting.md and README.md for the required backfill step.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending';

-- Constraint added separately so re-running this file after a manual edit
-- doesn't fail on "constraint already exists".
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tasks_moderation_status_check'
    ) THEN
        ALTER TABLE tasks
            ADD CONSTRAINT tasks_moderation_status_check
            CHECK (moderation_status IN ('pending', 'approved', 'quarantined', 'rejected'));
    END IF;
END $$;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS moderation_risk_score INTEGER,
    ADD COLUMN IF NOT EXISTS moderation_reason_codes TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS moderation_policy_version TEXT,
    ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS moderated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_moderation ON tasks(moderation_status);

-- An org whose tasks keep getting flagged can be suspended outright —
-- blocks new task creation and instant-hire (see POST /tasks and
-- POST /store/[listingId]/hire), independent of any single task's own
-- moderation decision.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS task_reports (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id            UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reporter_agent_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    reason_code        TEXT NOT NULL,
    details            TEXT,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(task_id, reporter_agent_id)
);

CREATE TABLE IF NOT EXISTS task_moderation_events (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type     TEXT NOT NULL CHECK (event_type IN (
                       'auto_moderated', 'reported', 'report_threshold_quarantine',
                       'admin_approved', 'admin_quarantined', 'admin_rejected',
                       'organization_suspended', 'appeal_submitted', 'appeal_resolved'
                   )),
    decision       TEXT CHECK (decision IN ('allow', 'allow_with_warning', 'quarantine', 'reject')),
    risk_score     INTEGER,
    reason_codes   TEXT[] DEFAULT '{}',
    policy_version TEXT,
    actor_type     TEXT NOT NULL CHECK (actor_type IN ('system', 'agent', 'admin', 'buyer')),
    actor_id       TEXT,
    notes          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_moderation_event_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'task_moderation_events is append-only — UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_moderation_events_no_update ON task_moderation_events;
CREATE TRIGGER task_moderation_events_no_update
    BEFORE UPDATE ON task_moderation_events
    FOR EACH ROW EXECUTE FUNCTION prevent_moderation_event_modification();

DROP TRIGGER IF EXISTS task_moderation_events_no_delete ON task_moderation_events;
CREATE TRIGGER task_moderation_events_no_delete
    BEFORE DELETE ON task_moderation_events
    FOR EACH ROW EXECUTE FUNCTION prevent_moderation_event_modification();

CREATE TABLE IF NOT EXISTS task_moderation_appeals (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id             UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    buyer_org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    message             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'upheld', 'overturned')),
    statement_of_reasons TEXT,
    resolved_by         TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_reports_task         ON task_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_moderation_events_task    ON task_moderation_events(task_id);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_task   ON task_moderation_appeals(task_id);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status ON task_moderation_appeals(status);

ALTER TABLE task_reports            ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_moderation_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_moderation_appeals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON task_reports;
CREATE POLICY "service_role_all" ON task_reports TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON task_moderation_events;
CREATE POLICY "service_role_all" ON task_moderation_events TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON task_moderation_appeals;
CREATE POLICY "service_role_all" ON task_moderation_appeals TO service_role USING (true) WITH CHECK (true);

-- Fresh self-host installs seed 7 sample tasks via 07_demo_tasks.sql, which
-- (as of this migration) inserts them with moderation_status = 'approved'
-- directly — they're platform-authored sample briefs, not third-party
-- submissions, so there is nothing to review. On an EXISTING database where
-- 07_demo_tasks.sql already ran before this migration existed, those rows
-- default to 'pending' like everything else; the one-off backfill below
-- promotes exactly the known sample titles and nothing else.
UPDATE tasks
SET moderation_status = 'approved',
    moderation_policy_version = 'v1',
    moderated_at = NOW(),
    moderated_by = 'system:demo_backfill'
WHERE moderation_status = 'pending'
  AND posted_by_org_id IN (SELECT id FROM organizations WHERE name = 'Mercatai Sample Briefs')
  AND title IN (
    'Verify 50 supplier invoices against the Czech business register',
    'Weekly cashflow summary from bank statement export',
    'Translate a 12-page SaaS onboarding guide EN → DE',
    'Competitive scan: EU invoicing SaaS pricing',
    'Extract line items from 30 scanned PDF receipts',
    'Write 6 product descriptions for an e-shop (CZ)',
    'Review a 400-line Python payment webhook handler'
  );
