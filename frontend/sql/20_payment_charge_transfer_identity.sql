-- 20: A single, idempotent, conflict-safe way to persist a transaction's
-- stripe_charge_id / stripe_transfer_id from Stripe's own current data.
--
-- Previously this was a best-effort, swallow-all-errors TypeScript helper
-- (captureChargeIdentity in frontend/lib/server/paymentState.ts) invoked
-- only while a transaction was still 'pending' or 'held'. Two real gaps
-- came out of a live sandbox run against a real Stripe test-mode account:
--   1. A destination charge's Transfer object is not always attached to
--      the Charge the instant it's captured — a read immediately after
--      capture can legitimately see stripe_transfer_id still unset.
--   2. Every path that finalizes a funded transaction (buyer approve,
--      admin dispute resolution, the hourly escrow-release cron) flips
--      escrow_status straight from 'held' to 'released' in the SAME
--      request as the capture. Once released, the old helper's
--      pending/held gate permanently excluded it from ever running
--      again — so a Transfer that only became visible a moment too late
--      was NEVER backfilled. stripe_charge_id was fine (present on the
--      PaymentIntent immediately); stripe_transfer_id silently never was.
--
-- record_payment_charge_identity fixes both: it works at ANY
-- escrow_status (including 'released'), and follows simple, safe write
-- rules —
--   * a NULL stored id can be filled in from Stripe's current data;
--   * an identical id is a no-op success (idempotent retry/redelivery);
--   * an EXISTING id that differs from what Stripe now reports is NEVER
--     overwritten — the mismatch is logged to audit_logs (inside the
--     same atomic write, so it can never be silently lost) and the
--     caller is told via *_conflict so it can surface a loud error
--     instead of papering over two different Stripe object ids for the
--     same transaction.
-- It never touches escrow_status, task status, agent reputation, or
-- free-task accounting — those remain exclusively finalize_funded_task's
-- and invalidate_task_funding's job. That separation is what makes this
-- function safe to call from a webhook retry, a plain status check, or
-- an already-'released' transaction without any risk of a second
-- capture, a second escrow release, or a duplicate reputation credit.
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
    -- Row-level lock: two concurrent callers for the same transaction
    -- (e.g. a webhook redelivery racing a buyer's status-check poll)
    -- serialize here rather than racing a lost update. Neither call does
    -- anything else transaction-mutating, so this never risks a deadlock
    -- against finalize_funded_task's own FOR UPDATE on the same row —
    -- whichever acquires it first simply finishes and releases before
    -- the other proceeds.
    SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
    END IF;

    -- Defense-in-depth: this must only ever record identity for the
    -- payment intent actually recorded on this transaction row, never
    -- write Stripe object ids onto the wrong transaction because of a
    -- caller bug or a stale/mismatched argument.
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

    -- Written unconditionally (never skipped, never only-on-throw) so a
    -- genuine mismatch is always on record even though the conflicting
    -- id is deliberately never applied.
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
