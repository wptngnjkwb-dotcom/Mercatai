-- 14: Stripe Connect account and payout monitoring.
--
-- Backs a dedicated Connect webhook (POST
-- /api/v1/payments/stripe-connect-webhook, signed with its own
-- STRIPE_CONNECT_WEBHOOK_SECRET — a production Stripe event destination
-- for "events on connected accounts" can use a different signing secret
-- than the platform-account payment webhook at
-- /api/v1/payments/stripe-webhook) that watches for a connected account
-- losing payout readiness (account.updated), its external bank
-- account/card changing status (account.external_account.updated), and a
-- payout to an agent's bank account failing (payout.*). This is
-- monitoring only: a payout event never touches tasks or transactions —
-- a single Stripe payout can bundle funds from many transactions, so
-- there is no reliable one-to-one task/transaction to update from it.
-- See frontend/lib/server/stripeConnectMonitoring.ts.
--
-- Every event handler re-fetches the CURRENT Account/Payout directly from
-- Stripe using the verified event.account, rather than trusting the
-- snapshot embedded in the webhook payload — Stripe does not guarantee
-- delivery order, so a late-arriving, stale event must never overwrite a
-- more current state with old data. Fetching fresh means there is no
-- "old" state left to accidentally apply: whichever event triggers the
-- fetch, the fetch itself always returns whatever is truly current.

-- Pure idempotency ledger for the Connect webhook, and a REAL LEASE, not
-- a permanent lock — see claim_stripe_connect_event() below. Stripe
-- redelivers events on timeout or retry, and two deliveries of the same
-- event can also race each other; a worker can also simply crash mid-way
-- through processing one. claim_token distinguishes which attempt
-- currently owns this row: mark-completed/mark-failed must match both id
-- AND claim_token, so a worker whose lease has since expired and been
-- reclaimed by a newer attempt can never overwrite that newer attempt's
-- result — its own update simply matches zero rows.
CREATE TABLE IF NOT EXISTS stripe_connect_events (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_event_id        TEXT NOT NULL UNIQUE,
    event_type             TEXT NOT NULL,
    stripe_account_id      TEXT,
    status                 TEXT NOT NULL DEFAULT 'processing'
                           CHECK (status IN ('processing', 'completed', 'failed')),
    claim_token            UUID NOT NULL,
    processing_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count          INTEGER NOT NULL DEFAULT 1,
    last_error             TEXT,
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    completed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_events_status ON stripe_connect_events(status);

-- Atomically claims a Stripe Connect event for processing. A brand-new
-- event is inserted as 'processing'. An existing event can be reclaimed
-- if it is 'failed' (a previous attempt did not finish) or if it is
-- 'processing' but its lease (processing_started_at) is older than
-- p_lease_seconds — the worker holding it presumably crashed or hung.
-- A FRESH 'processing' row (within its lease) and a 'completed' row are
-- never reclaimed. Every successful claim mints a brand-new claim_token
-- and bumps attempt_count. Concurrency safety comes from Postgres's own
-- row-level locking on the UPDATE: two simultaneous callers serialize on
-- the same row, and whichever runs second re-evaluates the WHERE clause
-- against the FIRST caller's already-committed (fresh) processing_started_at,
-- so it correctly fails to match and claims nothing.
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

-- Payout STATE ONLY. Deliberately stores nothing beyond the fields below —
-- never a bank account number, account holder name, or any other field
-- copied wholesale from Stripe's Payout object. Deliberately has no
-- task_id or transaction_id column either: a payout can merge funds from
-- multiple transactions, so it has no single task to attach to — do not
-- add one. amount_minor is Stripe's own smallest-currency-unit integer
-- (never divided by 100 here) — see formatMinorAmount() in
-- stripeConnectMonitoring.ts for why a fixed /100 is wrong for
-- zero-decimal currencies.
--
-- admin_alert_* tracks delivery of the critical payout.failed admin
-- alert as a durable, retryable claim (see claim_payout_admin_alert()
-- below) — independent of the webhook event's own claim/lease, so a
-- retry of a DIFFERENT later event for the same payout can still finish
-- delivering an alert an earlier event's attempt failed to send.
-- admin_alert_claim_token is this claim's own token, checked the same way
-- stripe_connect_events.claim_token is: the 'sent'/'failed' write is
-- conditioned on id + admin_alert_claim_token + status='sending', so a
-- worker whose lease already expired and was reclaimed by a newer
-- attempt can never overwrite that newer attempt's result.
-- admin_alert_payload_snapshot freezes the EXACT request that would be
-- sent to Resend (from, to, subject, html, and a payload_version for our
-- own bookkeeping) at the FIRST successful claim — every later retry
-- reuses it verbatim: it does not re-read ADMIN_ALERT_EMAIL or
-- NEXT_PUBLIC_BASE_URL, and does not re-render whatever the current
-- template happens to be by then, even if either changed in between
-- attempts. That is what keeps the payload identical across every retry
-- under the SAME Resend idempotency key (see
-- buildPayoutAlertIdempotencyKey() / buildAdminAlertProviderPayload() in
-- stripeConnectMonitoring.ts / email.ts). Never contains the Resend API
-- key, a bank account number, or other PII. Delivery is at-least-once:
-- Resend's own idempotency window (currently 24 hours) is what keeps a
-- retry from causing a second physical send within that window; outside
-- it, a repeated alert is possible and is treated as acceptable — after
-- a long outage, an administrator seeing the same alert twice is safer
-- than one going missing.
-- admin_alert_provider_id is Resend's own email id, stored once the send
-- is confirmed — never a bank account number or the raw Stripe object.
CREATE TABLE IF NOT EXISTS stripe_connect_payouts (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_payout_id            TEXT NOT NULL,
    stripe_account_id           TEXT NOT NULL,
    -- Nullable: a payout can arrive for a connected account this database
    -- has no matching agent for (a deleted agent record, or an account
    -- Mercatai never onboarded) — see the "unknown connected account"
    -- handling in stripeConnectMonitoring.ts. Still recorded and still
    -- alerted on, just without agent attribution.
    agent_id                    UUID REFERENCES agents(id) ON DELETE SET NULL,
    amount_minor                BIGINT NOT NULL,
    currency                    TEXT NOT NULL,
    status                      TEXT NOT NULL
                                CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
    arrival_date                TIMESTAMPTZ,
    failure_code                TEXT,
    admin_alert_status          TEXT NOT NULL DEFAULT 'pending'
                                CHECK (admin_alert_status IN ('pending', 'sending', 'sent', 'failed')),
    admin_alert_claim_token     UUID,
    admin_alert_claimed_at      TIMESTAMPTZ,
    admin_alert_sent_at         TIMESTAMPTZ,
    admin_alert_attempts        INTEGER NOT NULL DEFAULT 0,
    admin_alert_payload_snapshot JSONB,
    admin_alert_provider_id     TEXT,
    last_alert_error            TEXT,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (stripe_account_id, stripe_payout_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_agent  ON stripe_connect_payouts(agent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_status ON stripe_connect_payouts(status);

-- Atomically claims the right to (re)send the critical payout.failed
-- admin alert for one payout row. Claims 'pending' or 'failed' outright,
-- and a 'sending' claim whose own lease has expired (a worker crashed
-- between claiming and recording success/failure) — never a fresh
-- 'sending' claim or an already-'sent' one, so concurrent or repeated
-- failure events for the same payout never both send. Every successful
-- claim mints a brand-new admin_alert_claim_token and atomically
-- increments admin_alert_attempts (the increment is part of the same
-- UPDATE, so it can never race with a concurrent claim attempt on the
-- same row). p_payload_snapshot is only ever ADOPTED when no snapshot
-- exists yet (COALESCE keeps whatever was frozen by the very first
-- claim) — the RETURNED payload_snapshot is therefore always the
-- authoritative one every caller must actually send, regardless of which
-- attempt this is.
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

-- Current known readiness snapshot for one connected account — a
-- reliable, critically-written table (unlike audit_logs, which is
-- fire-and-forget best-effort and must never be the sole source of truth
-- for detecting a capability regression). One row per connected account,
-- upserted on every account.updated.
CREATE TABLE IF NOT EXISTS stripe_connect_account_status (
    stripe_account_id           TEXT PRIMARY KEY,
    agent_id                    UUID REFERENCES agents(id) ON DELETE SET NULL,
    charges_enabled              BOOLEAN NOT NULL,
    payouts_enabled              BOOLEAN NOT NULL,
    card_payments_status         TEXT NOT NULL,
    sepa_debit_payments_status   TEXT NOT NULL,
    transfers_status             TEXT NOT NULL,
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_account_status_agent ON stripe_connect_account_status(agent_id);

ALTER TABLE stripe_connect_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_payouts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_account_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_events;
CREATE POLICY "service_role_all" ON stripe_connect_events TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_payouts;
CREATE POLICY "service_role_all" ON stripe_connect_payouts TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_account_status;
CREATE POLICY "service_role_all" ON stripe_connect_account_status TO service_role USING (true) WITH CHECK (true);
