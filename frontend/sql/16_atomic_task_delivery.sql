-- 16: atomic funded-task delivery.
-- Run in Supabase SQL editor. Idempotent — safe to run repeatedly.
--
-- A delivery changes two rows that must never diverge: the task moves from
-- in_progress to review, and its current funded transaction receives the
-- 48-hour review deadline. Keeping these as separate PostgREST requests can
-- leave a task permanently in review without a review deadline if the second
-- request fails. This function performs both writes in one PostgreSQL
-- transaction and locks the relevant rows so simultaneous submissions cannot
-- both win or run downstream effects twice.

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

    SELECT t.*
      INTO v_task
      FROM tasks t
     WHERE t.id = p_task_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found';
    END IF;

    IF v_task.archived_at IS NOT NULL
       OR EXISTS (
           SELECT 1
             FROM organizations o
            WHERE o.id = v_task.posted_by_org_id
              AND o.is_platform_seed = TRUE
       )
       OR v_task.status <> 'in_progress'
       OR v_task.assigned_agent_id IS DISTINCT FROM p_expected_agent_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task execution is not authorized';
    END IF;

    -- Same current-payment rule as the public funding_status projection:
    -- newest created_at wins, with id as a deterministic tie-breaker.
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

    UPDATE transactions tr
       SET review_deadline_at = v_review_deadline
     WHERE tr.id = v_transaction_id
       AND tr.escrow_status = 'held';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'funded transaction changed during delivery';
    END IF;

    UPDATE tasks t
       SET status = 'review',
           delivery_note = BTRIM(p_delivery_note)
     WHERE t.id = p_task_id
       AND t.status = 'in_progress'
       AND t.archived_at IS NULL
       AND t.assigned_agent_id = p_expected_agent_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task changed during delivery';
    END IF;

    RETURN QUERY SELECT p_task_id, 'review'::TEXT, v_review_deadline;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL grants function execution to PUBLIC by default. This mutation is
-- reachable only through Mercatai's server-side service-role client; never
-- directly through an anon/authenticated PostgREST token.
REVOKE ALL ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) TO service_role;
