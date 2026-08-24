-- 11: Trust & Safety — task moderation.
-- Run in Supabase SQL editor. Idempotent — safe to run repeatedly.
--
-- Adds a moderation lifecycle to `tasks` that is independent of the
-- existing workflow `status` column. A task can be 'open' (workflow) and
-- 'quarantined' (moderation) simultaneously; only 'approved' tasks are
-- ever public, biddable, or surfaced in feeds/webhooks/auto-bid.
--
-- SAFETY: this migration does NOT blanket-approve any existing task. Every
-- row currently in `tasks` gets moderation_status = 'pending' by the column
-- default below, which means the public marketplace, task detail, activity
-- feed and bidding all stop showing them the moment the application code
-- from this same change is deployed — until they are explicitly reviewed.
-- The ONE exception is a narrow, targeted backfill near the end of this
-- file that approves only the platform's own seeded sample tasks (matched
-- by their dedicated seed organization, not by title) — see the comment
-- there. See docs/self-hosting.md and README.md for the required backfill
-- step for everything else.

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
    ADD COLUMN IF NOT EXISTS moderated_by TEXT,
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS buyer_email TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_moderation ON tasks(moderation_status);

-- An org whose tasks keep getting flagged can be suspended outright —
-- blocks new task creation and instant-hire (see POST /tasks and
-- POST /store/[listingId]/hire), independent of any single task's own
-- moderation decision. join_token_* lets a second agent join an existing
-- organization without owner_email ever being trusted as proof of
-- ownership — see POST /api/v1/agents.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_platform_seed BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS join_token_lookup_id TEXT,
    ADD COLUMN IF NOT EXISTS join_token_secret_hash TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'organizations_join_token_lookup_id_key'
    ) THEN
        ALTER TABLE organizations
            ADD CONSTRAINT organizations_join_token_lookup_id_key UNIQUE (join_token_lookup_id);
    END IF;
END $$;

-- Pre-existing gap, not introduced by this migration: POST /api/v1/agents
-- has always accepted owner_email and the Stripe onboarding routes have
-- always read/written stripe_account_id and stripe_onboarding_completed,
-- but none of the three ever made it into the canonical schema — a clean
-- self-host install would 500 the moment an agent tried to onboard to
-- Stripe. Fixed here since it's directly adjacent to the agents/
-- organizations identity work in this same migration.
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS owner_email TEXT,
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_onboarding_completed BOOLEAN NOT NULL DEFAULT false;

-- One Stripe Connect account must never end up attached to two agents —
-- that would misdirect one agent's payouts to the other's Stripe account.
-- Postgres already treats every NULL as distinct for uniqueness purposes,
-- so this doesn't need to be a partial index to tolerate the common
-- not-yet-onboarded case.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agents_stripe_account_id_key'
    ) THEN
        ALTER TABLE agents ADD CONSTRAINT agents_stripe_account_id_key UNIQUE (stripe_account_id);
    END IF;
END $$;

-- Backfill for agents that already existed before owner_email did: under
-- the pre-join-token registration flow, an org's name was set to the
-- registering agent's owner_email (or, if none was given, to agent_id —
-- the regex below is what tells those two cases apart, since only the
-- former is safe to copy back). Every agent sharing that organization
-- gets the same value, which is correct — they registered under the same
-- email originally. Idempotent (only touches owner_email IS NULL rows) and
-- purely additive: it can never overwrite an owner_email a post-fix
-- registration already set.
--
-- This cannot recover agents whose org name was never an email in the
-- first place (owner_email IS NULL and stays NULL after this runs) —
-- stripe-onboard/route.ts now fails those with a clear "contact email
-- required" error instead of silently sending Stripe a null email.
-- Before applying this migration to an existing database, check who
-- those are and consider backfilling them by hand:
--   SELECT id, agent_id, owner_org_id FROM agents WHERE owner_email IS NULL;
-- (rerun after this migration — the query is only useful post-backfill).
UPDATE agents AS a
SET owner_email = LOWER(TRIM(o.name))
FROM organizations AS o
WHERE a.owner_org_id = o.id
  AND a.owner_email IS NULL
  AND TRIM(o.name) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

-- One-time, trusted backfill: mark the existing seed org (created by
-- 07_demo_tasks.sql before this column existed) by its known name. Matching
-- by name here is a fixed, developer-authored migration statement, not
-- application code trusting request input — but the org-identity bug this
-- migration exists to close (see POST /tasks) means a row named exactly
-- "Mercatai Sample Briefs" could, on a database that ran the old
-- vulnerable code, have been created by an attacker rather than by
-- 07_demo_tasks.sql. Only auto-flag when the name is unambiguous (exactly
-- one match); if there's more than one, this is left for manual review
-- instead of guessing, and NOTICEs loudly so it isn't missed.
DO $$
DECLARE
    match_count INTEGER;
BEGIN
    SELECT count(*) INTO match_count FROM organizations WHERE name = 'Mercatai Sample Briefs';
    IF match_count = 1 THEN
        UPDATE organizations SET is_platform_seed = true
        WHERE name = 'Mercatai Sample Briefs' AND is_platform_seed = false;
    ELSIF match_count > 1 THEN
        RAISE NOTICE 'Skipping is_platform_seed backfill: % organizations are named "Mercatai Sample Briefs" — resolve manually (identify the real seed org, e.g. by its earliest created_at or its tasks'' content, and run: UPDATE organizations SET is_platform_seed = true WHERE id = ''<real-id>'').', match_count;
    END IF;
END $$;

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

-- Enforce "at most one pending appeal per task" atomically — the
-- application also checks this before inserting, but that check-then-insert
-- has a race window; this index closes it. A second concurrent insert gets
-- a unique-violation (23505), not a silently-created duplicate appeal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_appeals_one_pending
    ON task_moderation_appeals(task_id) WHERE status = 'pending';

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
-- promotes them.
--
-- Matched by the dedicated seed organization's is_platform_seed flag, NOT
-- by title text or org name — an earlier version of this migration matched
-- exact title strings, which is fragile (a since-edited sample title, a
-- punctuation/glyph difference) and would silently leave that one sample
-- stuck at 'pending' forever. A later version matched the org by name,
-- which a malicious POST /tasks caller could spoof by typing the same
-- name (see the org-resolution fix in POST /tasks and the hire route) to
-- make their own task masquerade as platform-authored; is_platform_seed
-- can only ever be set by this trusted migration script.
UPDATE tasks
SET moderation_status = 'approved',
    moderation_policy_version = 'v1',
    moderated_at = NOW(),
    published_at = NOW(),
    moderated_by = 'system:demo_backfill'
WHERE moderation_status = 'pending'
  AND posted_by_org_id IN (SELECT id FROM organizations WHERE is_platform_seed = true);

-- Historical backfill: every task that already existed before this
-- migration was, by definition, already live under the pre-moderation
-- codebase — task.created webhooks and auto-bid already fired for it at
-- creation time, whatever its current moderation_status ends up being
-- once reviewed. Recording that here means a later manual admin approval
-- (see PUT /admin/moderation/[taskId]) correctly treats it as
-- already-published and does not re-fire those side effects.
--
-- Discriminated by moderation_policy_version IS NULL, not a fixed cutoff
-- date/timestamp — a hardcoded date is wrong the moment a legitimate
-- historical task and this migration's actual deploy land on the same
-- calendar day, in either order. Every task inserted through the
-- moderation-aware code (POST /tasks, the hire route) always sets
-- moderation_policy_version; nothing pre-moderation ever did, so it's
-- unset on every row this backfill should touch and set on every row it
-- shouldn't — including on re-runs, which is what keeps this idempotent.
UPDATE tasks
SET published_at = created_at
WHERE published_at IS NULL
  AND moderation_policy_version IS NULL;
