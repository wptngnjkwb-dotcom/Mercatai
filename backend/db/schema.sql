-- Mercatai — kompletní databázové schema
-- Spustit v Supabase SQL Editoru

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- organizations
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL,
    verification_level  TEXT NOT NULL DEFAULT 'anonymous'
                        CHECK (verification_level IN ('anonymous', 'basic', 'verified_company')),
    is_suspended        BOOLEAN NOT NULL DEFAULT false,
    -- Identifies the platform's own seed/demo organization by an explicit
    -- flag, not by matching its display name — `name` is free text any
    -- caller can type, so recognizing "the real seed org" by name would
    -- let an attacker's task masquerade as platform-authored by simply
    -- reusing that exact string. Only ever set by trusted seed/migration
    -- scripts, never by application code handling request input.
    is_platform_seed    BOOLEAN NOT NULL DEFAULT false,
    -- Lets a second agent join the same organization as a first, without
    -- owner_email ever being trusted as proof of membership (knowing an
    -- email address is not the same as owning it). The token is
    -- "<join_token_lookup_id>.<secret>" — lookup_id is plaintext and
    -- indexed so the owning org can be found directly, the secret is
    -- bcrypt-hashed like agents.api_key_hash and only ever compared, never
    -- stored or re-derived. NULL until an agent registration first
    -- generates one for a brand new org; shown once in that response.
    join_token_lookup_id  TEXT UNIQUE,
    join_token_secret_hash TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- agents
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id                    TEXT UNIQUE NOT NULL,
    owner_org_id                UUID REFERENCES organizations(id) ON DELETE CASCADE,
    display_name                TEXT,
    description                 TEXT,
    capabilities                TEXT[] DEFAULT '{}',
    languages                   TEXT[] DEFAULT '{}',
    verification_level          TEXT DEFAULT 'anonymous',
    reputation_score            FLOAT DEFAULT 50.0
                                CHECK (reputation_score >= 0 AND reputation_score <= 100),
    tier                        INTEGER DEFAULT 1 CHECK (tier IN (1, 2, 3, 4)),
    avatar_book_id              TEXT,
    wallet_balance_eur          DECIMAL(12,2) DEFAULT 0.00,
    monthly_spending_limit_eur  DECIMAL(12,2),
    embedding                   VECTOR(1536),
    free_tasks_remaining        INTEGER DEFAULT 10,
    total_tasks_completed       INTEGER DEFAULT 0,
    success_rate                FLOAT DEFAULT 0.0,
    is_active                   BOOLEAN DEFAULT true,
    is_approved                 BOOLEAN DEFAULT false,
    registered_at               TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at                TIMESTAMPTZ,
    -- Contact email captured at registration (POST /api/v1/agents) — used
    -- as the Stripe Connect Express account's email at onboarding time.
    -- Never a lookup/identity key (see the join-token comment above on
    -- organizations); stored normalized (trimmed, lowercased) by the route.
    owner_email                 TEXT,
    -- One Stripe Connect account per agent — never shared, or one agent's
    -- payouts could be misdirected to another's Stripe account.
    stripe_account_id           TEXT UNIQUE,
    stripe_onboarding_completed BOOLEAN NOT NULL DEFAULT false,
    -- 'private' hides this agent from public discovery (directories, search,
    -- recommendations, Store) and profile/reputation/reviews/portfolio/work
    -- history, without affecting login, bidding, delivery, or payouts — see
    -- frontend/sql/12_agent_profile_visibility.sql for the full rationale
    -- and every place this is enforced. Defaults to 'public' so applying
    -- this to an existing database changes nothing for existing agents.
    profile_visibility          TEXT NOT NULL DEFAULT 'public'
                                CHECK (profile_visibility IN ('public', 'private'))
);

-- ============================================================
-- tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    posted_by_org_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
    title                TEXT NOT NULL,
    description          TEXT NOT NULL,
    category             TEXT CHECK (category IN (
                             'research', 'content', 'code_review',
                             'procurement', 'data_analysis', 'translation',
                             'finance'
                         )),
    required_capabilities TEXT[] DEFAULT '{}',
    required_languages    TEXT[] DEFAULT '{}',
    budget_min_eur       DECIMAL(10,2),
    budget_max_eur       DECIMAL(10,2),
    deadline_hours       INTEGER,
    status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN (
                             'open', 'bidding', 'assigned', 'in_progress',
                             'review', 'completed', 'disputed', 'cancelled'
                         )),
    assigned_agent_id    UUID REFERENCES agents(id),
    embedding            VECTOR(1536),
    bidding_closes_at    TIMESTAMPTZ,
    created_at           TIMESTAMPTZ DEFAULT NOW(),

    -- Trust & Safety moderation — independent of the workflow `status`
    -- above. A task can be 'open' (workflow) and 'quarantined'
    -- (moderation) at the same time; only 'approved' tasks are ever
    -- public, biddable, or surfaced in feeds/webhooks/auto-bid.
    moderation_status       TEXT NOT NULL DEFAULT 'pending'
                             CHECK (moderation_status IN (
                                 'pending', 'approved', 'quarantined', 'rejected'
                             )),
    moderation_risk_score   INTEGER,
    moderation_reason_codes TEXT[] DEFAULT '{}',
    moderation_policy_version TEXT,
    moderated_at            TIMESTAMPTZ,
    moderated_by            TEXT,
    -- Set once, the first time a task's moderation_status becomes
    -- 'approved' — distinct from moderation_status itself so a task that
    -- goes approved -> quarantined -> approved again never re-fires its
    -- publish side effects (webhooks, auto-bid, confirmation email).
    published_at            TIMESTAMPTZ,
    buyer_email              TEXT,
    -- Set by POST /api/v1/tasks/{id}/deliver when the assigned agent
    -- submits its work for buyer review.
    delivery_note            TEXT,
    -- Reversible visibility control — independent of both workflow status
    -- and moderation_status. NULL means visible everywhere; non-NULL hides
    -- the task from every public surface (GET /tasks, GET /tasks/[id], GET
    -- /tasks/[id]/bids, GET /activity) without deleting it, its bids, or
    -- its audit trail. See frontend/sql/15_task_archival.sql.
    archived_at              TIMESTAMPTZ,
    archived_reason          TEXT
);

-- ============================================================
-- bids
-- ============================================================
CREATE TABLE IF NOT EXISTS bids (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    price_eur        DECIMAL(10,2) NOT NULL,
    delivery_hours   INTEGER NOT NULL,
    approach_summary TEXT,
    -- Optional short sample of the agent's proposed work, shown to the
    -- buyer alongside the bid (POST /api/v1/bids, OpenAPI's Bid schema).
    sample_preview   TEXT,
    score            FLOAT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
    submitted_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(task_id, agent_id)
);

-- ============================================================
-- transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id                  UUID NOT NULL REFERENCES tasks(id),
    buyer_org_id             UUID NOT NULL REFERENCES organizations(id),
    agent_id                 UUID NOT NULL REFERENCES agents(id),
    gross_amount_eur         DECIMAL(10,2) NOT NULL,
    platform_fee_eur         DECIMAL(10,2) NOT NULL,
    stripe_fee_eur           DECIMAL(10,2) NOT NULL,
    agent_payout_eur         DECIMAL(10,2) NOT NULL,
    stripe_payment_intent_id TEXT,
    stripe_transfer_id       TEXT,
    escrow_status            TEXT NOT NULL DEFAULT 'held'
                             CHECK (escrow_status IN ('held', 'released', 'refunded', 'disputed')),
    review_deadline_at       TIMESTAMPTZ,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    released_at              TIMESTAMPTZ
);

-- Atomically moves a genuinely funded, non-demo, non-archived task from
-- in_progress to review and starts its 48-hour review window. See
-- frontend/sql/16_atomic_task_delivery.sql for the full rationale.
CREATE OR REPLACE FUNCTION submit_funded_task_delivery(
    p_task_id UUID,
    p_expected_agent_id UUID,
    p_delivery_note TEXT
) RETURNS TABLE (
    task_id UUID,
    task_status TEXT,
    review_deadline_at TIMESTAMPTZ
) AS $$
DECLARE
    v_task tasks%ROWTYPE;
    v_transaction_id UUID;
    v_escrow_status TEXT;
    v_review_deadline TIMESTAMPTZ;
BEGIN
    IF p_delivery_note IS NULL OR BTRIM(p_delivery_note) = '' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'delivery_note must not be empty';
    END IF;
    IF CHAR_LENGTH(BTRIM(p_delivery_note)) > 50000 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'delivery_note is too long';
    END IF;

    SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found';
    END IF;

    IF v_task.archived_at IS NOT NULL
       OR EXISTS (
           SELECT 1 FROM organizations o
            WHERE o.id = v_task.posted_by_org_id AND o.is_platform_seed = TRUE
       )
       OR v_task.status <> 'in_progress'
       OR v_task.assigned_agent_id IS DISTINCT FROM p_expected_agent_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task execution is not authorized';
    END IF;

    SELECT tr.id, tr.escrow_status
      INTO v_transaction_id, v_escrow_status
      FROM transactions tr
     WHERE tr.task_id = p_task_id
     ORDER BY tr.created_at DESC NULLS LAST, tr.id DESC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND OR v_escrow_status <> 'held' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task payment is not funded';
    END IF;

    v_review_deadline := CLOCK_TIMESTAMP() + INTERVAL '48 hours';
    UPDATE transactions tr SET review_deadline_at = v_review_deadline
     WHERE tr.id = v_transaction_id AND tr.escrow_status = 'held';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'funded transaction changed during delivery';
    END IF;

    UPDATE tasks t SET status = 'review', delivery_note = BTRIM(p_delivery_note)
     WHERE t.id = p_task_id AND t.status = 'in_progress'
       AND t.archived_at IS NULL AND t.assigned_agent_id = p_expected_agent_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task changed during delivery';
    END IF;

    RETURN QUERY SELECT p_task_id, 'review'::TEXT, v_review_deadline;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) TO service_role;

-- ============================================================
-- audit_logs  — APPEND ONLY
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id       UUID REFERENCES agents(id),
    user_id        UUID,
    action         TEXT NOT NULL,
    resource_type  TEXT,
    resource_id    UUID,
    details        JSONB,
    reasoning_hash TEXT,
    ip_address     TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: zakázat UPDATE a DELETE na audit_logs
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only — UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

-- ============================================================
-- reputation_events
-- ============================================================
CREATE TABLE IF NOT EXISTS reputation_events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL CHECK (event_type IN (
                    'task_completed', 'task_failed', 'dispute_lost',
                    'late_delivery', 'positive_review', 'fraud_detected'
                )),
    score_delta FLOAT NOT NULL,
    task_id     UUID REFERENCES tasks(id),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- task_reports — an agent flagging a task as unsafe
-- ============================================================
CREATE TABLE IF NOT EXISTS task_reports (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id            UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reporter_agent_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    reason_code        TEXT NOT NULL,
    details            TEXT,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(task_id, reporter_agent_id)
);

-- ============================================================
-- task_moderation_events — APPEND ONLY audit trail of every
-- moderation decision (automatic or admin) for a task
-- ============================================================
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

-- ============================================================
-- task_moderation_appeals — buyer-initiated review of a
-- quarantined/rejected task, resolved by an admin
-- ============================================================
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

-- ============================================================
-- stripe_connect_events — idempotency ledger AND lease for the Connect
-- webhook (POST /api/v1/payments/stripe-connect-webhook). claim_token +
-- processing_started_at make 'processing' a real, expiring lease rather
-- than a permanent lock — see claim_stripe_connect_event() below and
-- frontend/sql/14_stripe_connect_monitoring.sql for the full rationale.
-- ============================================================
CREATE TABLE IF NOT EXISTS stripe_connect_events (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_event_id       TEXT NOT NULL UNIQUE,
    event_type            TEXT NOT NULL,
    stripe_account_id     TEXT,
    status                TEXT NOT NULL DEFAULT 'processing'
                          CHECK (status IN ('processing', 'completed', 'failed')),
    claim_token           UUID NOT NULL,
    processing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count         INTEGER NOT NULL DEFAULT 1,
    last_error            TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    completed_at          TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION claim_stripe_connect_event(
    p_stripe_event_id TEXT,
    p_event_type TEXT,
    p_stripe_account_id TEXT,
    p_lease_seconds INTEGER DEFAULT 300
) RETURNS TABLE (id UUID, claim_token UUID, attempt_count INTEGER) AS $$
DECLARE
    v_id UUID;
    v_token UUID := uuid_generate_v4();
    v_attempts INTEGER;
BEGIN
    INSERT INTO stripe_connect_events (stripe_event_id, event_type, stripe_account_id, status, claim_token, processing_started_at, attempt_count)
    VALUES (p_stripe_event_id, p_event_type, p_stripe_account_id, 'processing', v_token, NOW(), 1)
    ON CONFLICT (stripe_event_id) DO NOTHING
    RETURNING stripe_connect_events.id INTO v_id;

    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, v_token, 1;
        RETURN;
    END IF;

    UPDATE stripe_connect_events e
    SET status = 'processing',
        claim_token = v_token,
        processing_started_at = NOW(),
        attempt_count = e.attempt_count + 1
    WHERE e.stripe_event_id = p_stripe_event_id
      AND (
          e.status = 'failed'
          OR (e.status = 'processing' AND e.processing_started_at < NOW() - (p_lease_seconds || ' seconds')::interval)
      )
    RETURNING e.id, e.attempt_count INTO v_id, v_attempts;

    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, v_token, v_attempts;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- stripe_connect_payouts — payout STATE ONLY (never bank account number,
-- account holder name, or any other field copied from Stripe's Payout
-- object). No task_id/transaction_id: a payout can merge funds from many
-- transactions, so it never maps to a single one. amount_minor is
-- Stripe's own smallest-currency-unit integer, never divided by 100 here
-- — see formatMinorAmount() in stripeConnectMonitoring.ts. admin_alert_*
-- tracks delivery of the critical payout.failed admin alert as its own
-- durable, retryable claim, independent of the webhook event's lease —
-- delivery is at-least-once, relying on Resend's own idempotency window
-- (see frontend/sql/14_stripe_connect_monitoring.sql for the full
-- rationale), not an absolute guarantee of exactly one email.
-- ============================================================
CREATE TABLE IF NOT EXISTS stripe_connect_payouts (
    id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_payout_id             TEXT NOT NULL,
    stripe_account_id            TEXT NOT NULL,
    agent_id                     UUID REFERENCES agents(id) ON DELETE SET NULL,
    amount_minor                 BIGINT NOT NULL,
    currency                     TEXT NOT NULL,
    status                       TEXT NOT NULL
                                 CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
    arrival_date                 TIMESTAMPTZ,
    failure_code                 TEXT,
    admin_alert_status           TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (admin_alert_status IN ('pending', 'sending', 'sent', 'failed')),
    admin_alert_claim_token      UUID,
    admin_alert_claimed_at       TIMESTAMPTZ,
    admin_alert_sent_at          TIMESTAMPTZ,
    admin_alert_attempts         INTEGER NOT NULL DEFAULT 0,
    admin_alert_payload_snapshot JSONB,
    admin_alert_provider_id      TEXT,
    last_alert_error             TEXT,
    created_at                   TIMESTAMPTZ DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (stripe_account_id, stripe_payout_id)
);

-- See frontend/sql/14_stripe_connect_monitoring.sql for the full
-- rationale on the lease/token/snapshot mechanics below.
CREATE OR REPLACE FUNCTION claim_payout_admin_alert(
    p_payout_row_id UUID,
    p_lease_seconds INTEGER DEFAULT 300,
    p_payload_snapshot JSONB DEFAULT NULL
) RETURNS TABLE (claim_token UUID, attempt_count INTEGER, payload_snapshot JSONB) AS $$
DECLARE
    v_token UUID := uuid_generate_v4();
    v_attempts INTEGER;
    v_snapshot JSONB;
BEGIN
    UPDATE stripe_connect_payouts p
    SET admin_alert_status = 'sending',
        admin_alert_claimed_at = NOW(),
        admin_alert_claim_token = v_token,
        admin_alert_attempts = p.admin_alert_attempts + 1,
        admin_alert_payload_snapshot = COALESCE(p.admin_alert_payload_snapshot, p_payload_snapshot)
    WHERE p.id = p_payout_row_id
      AND (
          p.admin_alert_status IN ('pending', 'failed')
          OR (p.admin_alert_status = 'sending' AND p.admin_alert_claimed_at < NOW() - (p_lease_seconds || ' seconds')::interval)
      )
    RETURNING p.admin_alert_attempts, p.admin_alert_payload_snapshot INTO v_attempts, v_snapshot;

    IF v_attempts IS NOT NULL THEN
        RETURN QUERY SELECT v_token, v_attempts, v_snapshot;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- stripe_connect_account_status — current known readiness snapshot per
-- connected account. A reliable, critically-written table (unlike
-- audit_logs, which is fire-and-forget best-effort) so a capability
-- regression can be detected even if the audit log write itself fails.
-- ============================================================
CREATE TABLE IF NOT EXISTS stripe_connect_account_status (
    stripe_account_id           TEXT PRIMARY KEY,
    agent_id                    UUID REFERENCES agents(id) ON DELETE SET NULL,
    charges_enabled             BOOLEAN NOT NULL,
    payouts_enabled             BOOLEAN NOT NULL,
    card_payments_status        TEXT NOT NULL,
    sepa_debit_payments_status  TEXT NOT NULL,
    transfers_status            TEXT NOT NULL,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_agents_embedding
    ON agents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_tasks_embedding
    ON tasks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Public listings (GET /agents, /agents/recommend, GET /store) filter on
-- is_active = true AND profile_visibility = 'public' together — a partial
-- index scoped to exactly that shape keeps it small and cheap regardless
-- of table size.
CREATE INDEX IF NOT EXISTS idx_agents_public_active
    ON agents (reputation_score DESC, id)
    WHERE is_active = true AND profile_visibility = 'public';

CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category    ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_moderation  ON tasks(moderation_status);
CREATE INDEX IF NOT EXISTS idx_tasks_archived    ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_bids_task_id      ON bids(task_id);
CREATE INDEX IF NOT EXISTS idx_bids_agent_id     ON bids(agent_id);
CREATE INDEX IF NOT EXISTS idx_bids_status       ON bids(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent  ON audit_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_res    ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time   ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rep_events_agent  ON reputation_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_task_reports_task       ON task_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_moderation_events_task  ON task_moderation_events(task_id);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_task ON task_moderation_appeals(task_id);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status ON task_moderation_appeals(status);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_events_status         ON stripe_connect_events(status);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_agent         ON stripe_connect_payouts(agent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_status        ON stripe_connect_payouts(status);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_account_status_agent  ON stripe_connect_account_status(agent_id);

-- ============================================================
-- Row Level Security (RLS) — základní politiky
-- ============================================================
ALTER TABLE organizations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_reports            ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_moderation_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_moderation_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_payouts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_account_status ENABLE ROW LEVEL SECURITY;

-- Service role má plný přístup (backend vždy používá service_role_key)
CREATE POLICY "service_role_all" ON organizations   TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON agents          TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON tasks           TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON bids            TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON transactions    TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON audit_logs      TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON reputation_events TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON task_reports            TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON task_moderation_events  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON task_moderation_appeals TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON stripe_connect_events         TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON stripe_connect_payouts        TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON stripe_connect_account_status TO service_role USING (true) WITH CHECK (true);
