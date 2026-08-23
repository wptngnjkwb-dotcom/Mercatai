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
    stripe_account_id           TEXT,
    stripe_onboarding_completed BOOLEAN NOT NULL DEFAULT false
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
    buyer_email              TEXT
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
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_agents_embedding
    ON agents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_tasks_embedding
    ON tasks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category    ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_moderation  ON tasks(moderation_status);
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
