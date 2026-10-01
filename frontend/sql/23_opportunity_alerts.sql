-- 23: explicit, agent-controlled opportunity alerts.
--
-- A published task is only an invitation to bid. It is NOT funded yet and
-- never authorizes execution. Every notification generated from these tables
-- states that work may start only after funding_status='funded' AND
-- execution_authorized=true.
--
-- Delivery is durable and at-least-once. The exact provider payload is frozen
-- before the first send; a deterministic Resend idempotency key makes retries
-- safe within the provider's idempotency window. The snapshot (which contains
-- the agent operator's email address) is cleared after a confirmed send, an
-- opt-out cancellation, or the final exhausted retry attempt — never left
-- behind once a delivery stops being retryable.

CREATE TABLE IF NOT EXISTS opportunity_alert_subscriptions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id       UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    categories     TEXT[] NOT NULL DEFAULT '{}',
    capabilities   TEXT[] NOT NULL DEFAULT '{}',
    locale         TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'cs', 'de', 'es')),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opportunity_alert_deliveries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id    UUID NOT NULL REFERENCES opportunity_alert_subscriptions(id) ON DELETE CASCADE,
    task_id             UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    payload_snapshot    JSONB,
    claim_token         UUID,
    claimed_at          TIMESTAMPTZ,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    provider_id         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at             TIMESTAMPTZ,
    UNIQUE (subscription_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_subscriptions_active
    ON opportunity_alert_subscriptions(is_active);
CREATE INDEX IF NOT EXISTS idx_opportunity_deliveries_retry
    ON opportunity_alert_deliveries(status, claimed_at)
    WHERE status IN ('pending', 'sending', 'failed');

ALTER TABLE opportunity_alert_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON opportunity_alert_subscriptions;
CREATE POLICY "service_role_all" ON opportunity_alert_subscriptions
    TO service_role USING (true) WITH CHECK (true);

ALTER TABLE opportunity_alert_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON opportunity_alert_deliveries;
CREATE POLICY "service_role_all" ON opportunity_alert_deliveries
    TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION claim_opportunity_alert_delivery(
    p_delivery_id UUID,
    p_lease_seconds INTEGER DEFAULT 300
) RETURNS TABLE (
    delivery_id UUID,
    subscription_id UUID,
    task_id UUID,
    payload_snapshot JSONB,
    claim_token UUID,
    attempt_count INTEGER
) AS $$
BEGIN
    RETURN QUERY
    UPDATE opportunity_alert_deliveries d
       SET status = 'sending',
           claim_token = gen_random_uuid(),
           claimed_at = NOW(),
           attempt_count = d.attempt_count + 1,
           last_error = NULL
     WHERE d.id = p_delivery_id
       AND d.payload_snapshot IS NOT NULL
       AND (
           d.status IN ('pending', 'failed')
           OR (
               d.status = 'sending'
               AND d.claimed_at < NOW() - make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 3600)))
           )
       )
    RETURNING d.id, d.subscription_id, d.task_id, d.payload_snapshot, d.claim_token, d.attempt_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION claim_opportunity_alert_delivery(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_opportunity_alert_delivery(UUID, INTEGER) TO service_role;
