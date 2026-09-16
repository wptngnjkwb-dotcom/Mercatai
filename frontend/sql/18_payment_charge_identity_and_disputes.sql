-- 18: stable Charge identity on transactions, plus minimal dispute
-- monitoring for the main payment webhook.
-- Run in Supabase SQL editor. Idempotent and non-destructive.
--
-- Part 1: transactions.stripe_charge_id was missing entirely —
-- stripe_transfer_id already existed in schema.sql but was never written
-- by any code path. Both are populated opportunistically by
-- reconcilePaymentIntent() once a transaction is funded (stripe_charge_id
-- from the PaymentIntent's own latest_charge field, no extra Stripe call;
-- stripe_transfer_id best-effort via one additional charges.retrieve,
-- since the Transfer id lives on the Charge, not the PaymentIntent).
-- Neither is required for the escrow state machine itself — they exist so
-- a dispute event (which carries charge/payment_intent ids, not a task or
-- transaction id) can be matched back to the right Mercatai transaction
-- without guessing, and so an admin can jump straight to the right Stripe
-- Dashboard object.

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;

-- stripe_payment_intent_id already has a unique index from migration 17
-- (uq_transactions_stripe_payment_intent) — no separate index needed here.
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_charge_id ON transactions(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;

-- Part 2: minimal, safe dispute monitoring — observation and alerting
-- only. This table and its admin-alert claim function never move money;
-- see frontend/lib/server/paymentDisputes.ts, which explicitly never
-- issues a refund, reverses a transfer, or pays anyone out. It exists so
-- a charge.dispute.* event (currently silently ignored by
-- /api/v1/payments/stripe-webhook — it isn't a payment_intent.* type) is
-- recorded, matched to a transaction where possible, and an administrator
-- is reliably notified with a retryable alert, mirroring the exact
-- claim/lease/frozen-payload pattern already proven for
-- stripe_connect_payouts.admin_alert_* in
-- frontend/sql/14_stripe_connect_monitoring.sql — see that file's own
-- comments for the full reasoning (repeated only briefly below).
--
-- Never stores card data: only the dispute's id, status, reason (a Stripe
-- enum like "fraudulent" or "product_not_received", never PAN/CVC/etc.),
-- amount, and currency — the same category of data already stored on
-- transactions today.
CREATE TABLE IF NOT EXISTS payment_disputes (
    id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_dispute_id             TEXT NOT NULL UNIQUE,
    stripe_charge_id              TEXT,
    stripe_payment_intent_id      TEXT,
    -- Nullable: a dispute can arrive for a charge this database has no
    -- matching transaction for (e.g. a very old or manually-created
    -- charge) — still recorded and still alerted on, just without
    -- transaction attribution, the same tolerance
    -- stripe_connect_payouts.agent_id already has for an unrecognized
    -- connected account.
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

CREATE INDEX IF NOT EXISTS idx_payment_disputes_transaction ON payment_disputes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_status ON payment_disputes(status);

-- Same shape and semantics as claim_payout_admin_alert() in migration 14:
-- claims 'pending'/'failed' outright, or a 'sending' claim whose lease
-- has expired; never a fresh 'sending' or an already-'sent' claim. Mints
-- a new claim_token and atomically increments admin_alert_attempts.
-- p_payload_snapshot is only ever ADOPTED when no snapshot exists yet.
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

-- Same rationale as migration 16/17's functions: PostgreSQL grants
-- function execution to PUBLIC by default. This is reachable only
-- through Mercatai's server-side service-role client.
REVOKE ALL ON FUNCTION claim_dispute_admin_alert(UUID, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_dispute_admin_alert(UUID, INTEGER, JSONB) TO service_role;

ALTER TABLE payment_disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON payment_disputes;
CREATE POLICY "service_role_all" ON payment_disputes TO service_role USING (true) WITH CHECK (true);
