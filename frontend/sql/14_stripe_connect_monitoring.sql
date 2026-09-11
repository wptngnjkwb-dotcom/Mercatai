-- 14: Stripe Connect account and payout monitoring.
--
-- Backs a dedicated Connect webhook (POST
-- /api/v1/payments/stripe-connect-webhook, signed with its own
-- STRIPE_CONNECT_WEBHOOK_SECRET — a production Stripe event destination
-- for "events on connected accounts" can use a different signing secret
-- than the platform-account payment webhook at
-- /api/v1/payments/stripe-webhook) that watches for a connected account
-- losing payout readiness (account.updated) and for a payout to an
-- agent's bank account failing (payout.*). This is monitoring only: a
-- payout event never touches tasks or transactions — a single Stripe
-- payout can bundle funds from many transactions, so there is no reliable
-- one-to-one task/transaction to update from it. See
-- frontend/lib/server/stripeConnectMonitoring.ts.

-- Pure idempotency ledger for the Connect webhook. Stripe redelivers
-- events on timeout or retry, and UNIQUE(stripe_event_id) is what turns a
-- redelivery into a no-op instead of a duplicate admin alert or a
-- double-counted audit entry. status starts 'processing' and only
-- becomes 'completed' once every critical write for that event has
-- actually succeeded — a crash or DB error midway leaves it
-- 'processing' or 'failed' on purpose: a fresh Stripe retry (a new HTTP
-- delivery of the same event) is what gets to actually finish the work,
-- not a cron job or a manual fixup script.
CREATE TABLE IF NOT EXISTS stripe_connect_events (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_event_id   TEXT NOT NULL UNIQUE,
    event_type        TEXT NOT NULL,
    stripe_account_id TEXT,
    status            TEXT NOT NULL DEFAULT 'processing'
                      CHECK (status IN ('processing', 'completed', 'failed')),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

-- Payout STATE ONLY. Deliberately stores nothing beyond the fields below —
-- never a bank account number, account holder name, or any other field
-- copied wholesale from Stripe's Payout object. Deliberately has no
-- task_id or transaction_id column either: a payout can merge funds from
-- multiple transactions, so it has no single task to attach to — do not
-- add one.
CREATE TABLE IF NOT EXISTS stripe_connect_payouts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_payout_id  TEXT NOT NULL,
    stripe_account_id TEXT NOT NULL,
    -- Nullable: a payout can arrive for a connected account this database
    -- has no matching agent for (a deleted agent record, or an account
    -- Mercatai never onboarded) — see the "unknown connected account"
    -- handling in stripeConnectMonitoring.ts. Still recorded and still
    -- alerted on, just without agent attribution.
    agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
    amount            DECIMAL(12,2) NOT NULL,
    currency          TEXT NOT NULL,
    status            TEXT NOT NULL
                      CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
    arrival_date      TIMESTAMPTZ,
    failure_code      TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (stripe_account_id, stripe_payout_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_events_status   ON stripe_connect_events(status);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_agent   ON stripe_connect_payouts(agent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_status  ON stripe_connect_payouts(status);

ALTER TABLE stripe_connect_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_events;
CREATE POLICY "service_role_all" ON stripe_connect_events TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON stripe_connect_payouts;
CREATE POLICY "service_role_all" ON stripe_connect_payouts TO service_role USING (true) WITH CHECK (true);
