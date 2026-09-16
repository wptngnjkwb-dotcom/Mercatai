-- 19: Explicitly restrict internal payment/monitoring RPCs to service_role.
--
-- Supabase may add explicit EXECUTE grants for anon and authenticated when a
-- function is created. Revoking only PUBLIC therefore does not reliably make
-- a server-only RPC private. This migration is idempotent and intentionally
-- repeats the grants for every internal RPC introduced by migrations 14–18.

REVOKE ALL ON FUNCTION claim_stripe_connect_event(TEXT, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_payout_admin_alert(UUID, INTEGER, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION accept_task_bid(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_task_payment(UUID, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION invalidate_task_funding(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_funded_task(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_task_refund(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_dispute_admin_alert(UUID, INTEGER, JSONB)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION claim_stripe_connect_event(TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION claim_payout_admin_alert(UUID, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION accept_task_bid(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION claim_task_payment(UUID, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION invalidate_task_funding(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_funded_task(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_task_refund(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION claim_dispute_admin_alert(UUID, INTEGER, JSONB) TO service_role;
