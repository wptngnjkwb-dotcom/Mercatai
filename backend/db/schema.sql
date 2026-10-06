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
    -- Legacy Express account. Retained only for the three explicitly
    -- designated October 2026 pilot tasks; every other task uses the
    -- Standard/full-dashboard account below.
    stripe_account_id           TEXT UNIQUE,
    stripe_onboarding_completed BOOLEAN NOT NULL DEFAULT false,
    -- Default account for all new marketplace payments. A Standard/full
    -- Dashboard account makes Stripe the fee and loss collector; it must
    -- never be silently substituted with the legacy Express account.
    stripe_standard_account_id  TEXT UNIQUE,
    stripe_standard_onboarding_completed BOOLEAN NOT NULL DEFAULT false,
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
    archived_reason          TEXT,
    -- Public, immutable-by-clients disclosure of which Stripe controller
    -- model an eventual payment requires. New tasks always default to the
    -- Standard/agent-liability model; only three production pilot UUIDs are
    -- migrated to the legacy Express/platform-liability model.
    stripe_account_requirement TEXT NOT NULL DEFAULT 'standard_agent_liability'
      CONSTRAINT tasks_stripe_account_requirement_check CHECK (stripe_account_requirement IN (
        'standard_agent_liability',
        'legacy_express_platform_liability'
      ))
      CONSTRAINT tasks_legacy_express_pilot_only_check CHECK (
        stripe_account_requirement <> 'legacy_express_platform_liability'
        OR id IN (
          'e427ab6c-62fa-473f-8e84-93003b13a47f'::uuid,
          '49a315bc-70ea-409d-b46d-d60ac369e23a'::uuid,
          '2ee876c6-ebc7-489e-b138-306ecdb32eaf'::uuid
        )
      )
);

-- ============================================================
-- bids
-- ============================================================
CREATE TABLE IF NOT EXISTS bids (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    price_eur        DECIMAL(10,2) NOT NULL,
    delivery_hours   INTEGER NOT NULL CHECK (delivery_hours BETWEEN 1 AND 8760),
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
    stripe_charge_id         TEXT,
    stripe_transfer_id       TEXT,
    -- Immutable Stripe object namespace. New payments use Direct Charges;
    -- pre-migration PaymentIntents remain destination charges.
    stripe_charge_model      TEXT CHECK (stripe_charge_model IS NULL OR stripe_charge_model IN ('destination', 'direct')),
    stripe_connected_account_id TEXT,
    stripe_account_requirement TEXT CHECK (
      stripe_account_requirement IS NULL OR stripe_account_requirement IN (
        'standard_agent_liability',
        'legacy_express_platform_liability'
      )
    ),
    CONSTRAINT transactions_stripe_charge_context_check CHECK (
      stripe_charge_model IS NULL
      OR (stripe_charge_model = 'destination' AND stripe_connected_account_id IS NULL)
      OR (stripe_charge_model = 'direct' AND stripe_connected_account_id ~ '^acct_')
    ),
    payment_attempt_key      UUID NOT NULL DEFAULT uuid_generate_v4(),
    payment_method           TEXT CHECK (payment_method IS NULL OR payment_method IN ('card', 'sepa_debit')),
    escrow_status            TEXT NOT NULL DEFAULT 'pending'
                             CHECK (escrow_status IN ('pending', 'held', 'released', 'refunded', 'disputed', 'failed')),
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
-- payment_disputes — minimal, safe monitoring for charge.dispute.*
-- events on the MAIN payment webhook (/api/v1/payments/stripe-webhook),
-- not the Connect webhook. Observation and alerting only — never moves
-- money, never reverses a transfer, never issues a refund. Never stores
-- card data: only the dispute's id, status, reason (a Stripe enum),
-- amount, and currency. admin_alert_* mirrors
-- stripe_connect_payouts.admin_alert_* exactly (same claim/lease/frozen-
-- payload semantics) — see frontend/sql/18_payment_charge_identity_and_
-- disputes.sql and frontend/lib/server/paymentDisputes.ts.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_disputes (
    id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_dispute_id             TEXT NOT NULL UNIQUE,
    stripe_charge_id              TEXT,
    stripe_payment_intent_id      TEXT,
    stripe_connected_account_id   TEXT,
    transaction_id                UUID REFERENCES transactions(id) ON DELETE SET NULL,
    status                        TEXT NOT NULL,
    reason                        TEXT,
    amount_minor                  BIGINT NOT NULL,
    currency                      TEXT NOT NULL,
    admin_alert_status            TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (admin_alert_status IN ('pending', 'sending', 'sent', 'failed')),
    admin_alert_claim_token       UUID,
    admin_alert_claimed_at        TIMESTAMPTZ,
    admin_alert_sent_at           TIMESTAMPTZ,
    admin_alert_attempts          INTEGER NOT NULL DEFAULT 0,
    admin_alert_payload_snapshot  JSONB,
    admin_alert_provider_id       TEXT,
    last_alert_error              TEXT,
    created_at                    TIMESTAMPTZ DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION claim_dispute_admin_alert(
    p_dispute_row_id UUID,
    p_lease_seconds INTEGER DEFAULT 300,
    p_payload_snapshot JSONB DEFAULT NULL
) RETURNS TABLE (claim_token UUID, attempt_count INTEGER, payload_snapshot JSONB) AS $$
DECLARE
    v_token UUID := uuid_generate_v4();
    v_attempts INTEGER;
    v_snapshot JSONB;
BEGIN
    UPDATE payment_disputes d
    SET admin_alert_status = 'sending',
        admin_alert_claimed_at = NOW(),
        admin_alert_claim_token = v_token,
        admin_alert_attempts = d.admin_alert_attempts + 1,
        admin_alert_payload_snapshot = COALESCE(d.admin_alert_payload_snapshot, p_payload_snapshot)
    WHERE d.id = p_dispute_row_id
      AND (
          d.admin_alert_status IN ('pending', 'failed')
          OR (d.admin_alert_status = 'sending' AND d.admin_alert_claimed_at < NOW() - (p_lease_seconds || ' seconds')::interval)
      )
    RETURNING d.admin_alert_attempts, d.admin_alert_payload_snapshot INTO v_attempts, v_snapshot;

    IF v_attempts IS NOT NULL THEN
        RETURN QUERY SELECT v_token, v_attempts, v_snapshot;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION claim_dispute_admin_alert(UUID, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_dispute_admin_alert(UUID, INTEGER, JSONB) TO service_role;

-- Idempotent, conflict-safe stripe_charge_id/stripe_transfer_id recorder —
-- works at any escrow_status (including 'released'), never overwrites an
-- existing differing id. See frontend/sql/20_payment_charge_transfer_identity.sql
-- for the full rationale.
CREATE OR REPLACE FUNCTION record_payment_charge_identity(
    p_transaction_id UUID,
    p_stripe_payment_intent_id TEXT,
    p_stripe_charge_id TEXT,
    p_stripe_transfer_id TEXT
) RETURNS TABLE (
    transaction_id UUID,
    stripe_charge_id TEXT,
    stripe_transfer_id TEXT,
    charge_id_written BOOLEAN,
    transfer_id_written BOOLEAN,
    charge_id_conflict BOOLEAN,
    transfer_id_conflict BOOLEAN
) AS $$
DECLARE
    v_tx transactions%ROWTYPE;
    v_new_charge_id TEXT;
    v_new_transfer_id TEXT;
    v_charge_written BOOLEAN := FALSE;
    v_transfer_written BOOLEAN := FALSE;
    v_charge_conflict BOOLEAN := FALSE;
    v_transfer_conflict BOOLEAN := FALSE;
BEGIN
    SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
    END IF;

    IF v_tx.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'payment intent does not match this transaction';
    END IF;

    v_new_charge_id := v_tx.stripe_charge_id;
    v_new_transfer_id := v_tx.stripe_transfer_id;

    IF p_stripe_charge_id IS NOT NULL THEN
        IF v_tx.stripe_charge_id IS NULL THEN
            v_new_charge_id := p_stripe_charge_id;
            v_charge_written := TRUE;
        ELSIF v_tx.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id THEN
            v_charge_conflict := TRUE;
        END IF;
    END IF;

    IF p_stripe_transfer_id IS NOT NULL THEN
        IF v_tx.stripe_transfer_id IS NULL THEN
            v_new_transfer_id := p_stripe_transfer_id;
            v_transfer_written := TRUE;
        ELSIF v_tx.stripe_transfer_id IS DISTINCT FROM p_stripe_transfer_id THEN
            v_transfer_conflict := TRUE;
        END IF;
    END IF;

    IF v_charge_written OR v_transfer_written THEN
        UPDATE transactions tr
           SET stripe_charge_id = v_new_charge_id,
               stripe_transfer_id = v_new_transfer_id
         WHERE tr.id = v_tx.id;
    END IF;

    IF v_charge_conflict OR v_transfer_conflict THEN
        INSERT INTO audit_logs(action, resource_type, resource_id, details)
        VALUES ('payment_identity_mismatch', 'transaction', v_tx.id, jsonb_build_object(
            'stripe_payment_intent_id', p_stripe_payment_intent_id,
            'existing_charge_id', v_tx.stripe_charge_id,
            'candidate_charge_id', p_stripe_charge_id,
            'charge_id_conflict', v_charge_conflict,
            'existing_transfer_id', v_tx.stripe_transfer_id,
            'candidate_transfer_id', p_stripe_transfer_id,
            'transfer_id_conflict', v_transfer_conflict
        ));
    END IF;

    RETURN QUERY SELECT v_tx.id, v_new_charge_id, v_new_transfer_id,
        v_charge_written, v_transfer_written, v_charge_conflict, v_transfer_conflict;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION record_payment_charge_identity(UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_payment_charge_identity(UUID, TEXT, TEXT, TEXT) TO service_role;

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
-- Opt-in opportunity alerts
-- ============================================================
CREATE TABLE IF NOT EXISTS opportunity_alert_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    categories TEXT[] NOT NULL DEFAULT '{}',
    capabilities TEXT[] NOT NULL DEFAULT '{}',
    locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'cs', 'de', 'es')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opportunity_alert_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID NOT NULL REFERENCES opportunity_alert_subscriptions(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    payload_snapshot JSONB,
    claim_token UUID,
    claimed_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    provider_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    UNIQUE (subscription_id, task_id)
);

CREATE OR REPLACE FUNCTION claim_opportunity_alert_delivery(
    p_delivery_id UUID,
    p_lease_seconds INTEGER DEFAULT 300
) RETURNS TABLE (delivery_id UUID, subscription_id UUID, task_id UUID, payload_snapshot JSONB, claim_token UUID, attempt_count INTEGER) AS $$
BEGIN
    RETURN QUERY
    UPDATE opportunity_alert_deliveries d
       SET status='sending', claim_token=gen_random_uuid(), claimed_at=NOW(),
           attempt_count=d.attempt_count+1, last_error=NULL
     WHERE d.id=p_delivery_id AND d.payload_snapshot IS NOT NULL
       AND (d.status IN ('pending','failed') OR (d.status='sending' AND d.claimed_at < NOW() - make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 3600)))))
    RETURNING d.id, d.subscription_id, d.task_id, d.payload_snapshot, d.claim_token, d.attempt_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION claim_opportunity_alert_delivery(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_opportunity_alert_delivery(UUID, INTEGER) TO service_role;

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
CREATE UNIQUE INDEX IF NOT EXISTS uq_bids_one_accepted_per_task ON bids(task_id) WHERE status = 'accepted';
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_payment_attempt_key ON transactions(payment_attempt_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_stripe_payment_intent ON transactions(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_one_active_per_task ON transactions(task_id) WHERE escrow_status IN ('pending', 'held');
CREATE INDEX IF NOT EXISTS idx_transactions_task_created ON transactions(task_id, created_at DESC, id DESC);
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
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_charge_id ON transactions(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_disputes_transaction ON payment_disputes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_status ON payment_disputes(status);
CREATE INDEX IF NOT EXISTS idx_opportunity_subscriptions_active ON opportunity_alert_subscriptions(is_active);
CREATE INDEX IF NOT EXISTS idx_opportunity_deliveries_retry ON opportunity_alert_deliveries(status, claimed_at) WHERE status IN ('pending','sending','failed');

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
ALTER TABLE payment_disputes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_alert_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_alert_deliveries ENABLE ROW LEVEL SECURITY;

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
CREATE POLICY "service_role_all" ON payment_disputes               TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON opportunity_alert_subscriptions TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON opportunity_alert_deliveries TO service_role USING (true) WITH CHECK (true);
