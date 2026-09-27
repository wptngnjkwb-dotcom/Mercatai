-- 22: replaces the marketplace "dispute" mechanism (buyer disputes a
-- delivery, Mercatai admin decides refund_buyer vs pay_agent) with a
-- neutral Quality Issue facilitation flow.
-- Run in Supabase SQL editor. Idempotent and non-destructive.
--
-- Why: Mercatai is a technical B2B marketplace, not a party to the
-- buyer/agent contract and not an adjudicator of work quality. The old
-- flow (tasks.status='disputed' + PUT /api/v1/admin/resolve/{taskId}
-- choosing refund_buyer/pay_agent) had Mercatai make exactly that
-- judgment call. This migration does not delete or resolve any existing
-- 'disputed' task — see docs/quality-issue-migration.md for the safe,
-- explicit handling of historical disputed tasks. tasks.status='disputed'
-- remains a valid value: invalidate_task_funding() (migration 17) still
-- uses it for a genuinely objective, Stripe-reported authorization
-- failure, which is unrelated to a buyer's quality complaint and is not
-- touched by this migration.
--
-- New model: a quality_issue is opened by the buyer while a task is in
-- 'review' (delivered, awaiting the buyer's decision). It never itself
-- moves money or changes tasks.status. It buys the parties a one-time
-- 72-hour extension of the existing review window (the same
-- transactions.review_deadline_at the 48h auto-release cron already
-- polls — see frontend/app/api/cron/release-escrow/route.ts, unchanged
-- by this migration) so they can reach agreement through a private
-- message thread. Exactly two objective outcomes end it:
--   1. the buyer approves anyway (existing PUT /api/v1/tasks/{id}/approve)
--   2. the agent voluntarily accepts a full refund (new endpoint,
--      reusing finalize_task_refund below)
-- If neither happens before the (possibly extended) deadline, the
-- existing, unmodified 48h auto-release cron finalizes the task exactly
-- as it always has — this migration only teaches finalize_funded_task
-- and finalize_task_refund to also close whatever quality_issue was open
-- for that task, atomically, as a side effect of the same finalization
-- they were already doing.

CREATE TABLE IF NOT EXISTS quality_issues (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id               UUID NOT NULL REFERENCES tasks(id),
    opened_by_org_id      UUID NOT NULL REFERENCES organizations(id),
    assigned_agent_id     UUID NOT NULL REFERENCES agents(id),
    status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'buyer_approved', 'agent_refunded', 'expired', 'closed')),
    -- A small, fixed set of objective categories — not free-text quality
    -- judgment. 'other' plus the required initial_message covers anything
    -- not captured by the first three.
    reason_code           TEXT NOT NULL
                          CHECK (reason_code IN ('not_as_described', 'incomplete_delivery', 'quality_below_expectations', 'other')),
    initial_message        TEXT NOT NULL,
    opened_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_deadline_at   TIMESTAMPTZ NOT NULL,
    resolved_at             TIMESTAMPTZ,
    resolution              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one OPEN quality issue per task — a second open() call while one
-- is already open fails this constraint (23505), surfaced by the API as a
-- 409, never as a second concurrent issue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_issues_one_open_per_task
    ON quality_issues(task_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_quality_issues_task_id ON quality_issues(task_id);
CREATE INDEX IF NOT EXISTS idx_quality_issues_assigned_agent_id ON quality_issues(assigned_agent_id);

-- Never public, never in the activity feed, never exposed to anyone but
-- the task's buyer (via task-bound buyer token) and the assigned agent
-- (via its own access token) — see open_quality_issue()'s callers in
-- frontend/app/api/v1/tasks/[id]/issues/route.ts, which are the only
-- server code that ever selects from this table for a non-admin caller.
CREATE TABLE IF NOT EXISTS quality_issue_messages (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    quality_issue_id    UUID NOT NULL REFERENCES quality_issues(id) ON DELETE CASCADE,
    author_role         TEXT NOT NULL CHECK (author_role IN ('buyer', 'agent')),
    author_org_id       UUID REFERENCES organizations(id),
    author_agent_id     UUID REFERENCES agents(id),
    message             TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (author_role = 'buyer' AND author_org_id IS NOT NULL AND author_agent_id IS NULL) OR
        (author_role = 'agent' AND author_agent_id IS NOT NULL AND author_org_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_quality_issue_messages_issue_id ON quality_issue_messages(quality_issue_id);

ALTER TABLE quality_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON quality_issues;
CREATE POLICY "service_role_all" ON quality_issues TO service_role USING (true) WITH CHECK (true);

ALTER TABLE quality_issue_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON quality_issue_messages;
CREATE POLICY "service_role_all" ON quality_issue_messages TO service_role USING (true) WITH CHECK (true);

-- Opens a quality issue and, only the very first time one is ever opened
-- for this task (checked by history, not just the current open one — see
-- comment inline), extends the transaction's review_deadline_at by 72
-- hours. A second, later quality issue on the same task (only reachable
-- if a prior one already resolved the task out of 'review' and somehow
-- back into it — not a normal path today) never extends the deadline
-- again.
CREATE OR REPLACE FUNCTION open_quality_issue(
    p_task_id UUID,
    p_opened_by_org_id UUID,
    p_reason_code TEXT,
    p_initial_message TEXT
) RETURNS TABLE (
    issue_id UUID,
    status TEXT,
    response_deadline_at TIMESTAMPTZ,
    deadline_extended BOOLEAN
) AS $$
DECLARE
    v_task tasks%ROWTYPE;
    v_tx transactions%ROWTYPE;
    v_issue_id UUID;
    v_is_first BOOLEAN;
    v_deadline TIMESTAMPTZ;
BEGIN
    IF p_reason_code NOT IN ('not_as_described', 'incomplete_delivery', 'quality_below_expectations', 'other') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid reason_code';
    END IF;
    IF p_initial_message IS NULL OR BTRIM(p_initial_message) = '' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'initial_message must not be empty';
    END IF;
    IF CHAR_LENGTH(BTRIM(p_initial_message)) > 5000 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'initial_message is too long';
    END IF;

    SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found'; END IF;
    IF v_task.archived_at IS NOT NULL
       OR v_task.moderation_status <> 'approved'
       OR v_task.status <> 'review'
       OR v_task.posted_by_org_id IS DISTINCT FROM p_opened_by_org_id
       OR v_task.assigned_agent_id IS NULL
       OR EXISTS (
         SELECT 1 FROM organizations o
          WHERE o.id = v_task.posted_by_org_id AND o.is_platform_seed = TRUE
       ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task is not eligible for a quality issue';
    END IF;

    SELECT tr.* INTO v_tx
      FROM transactions tr
     WHERE tr.task_id = p_task_id
     ORDER BY tr.created_at DESC NULLS LAST, tr.id DESC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND
       OR v_tx.escrow_status <> 'held'
       OR v_tx.review_deadline_at IS NULL
       OR v_tx.agent_id IS DISTINCT FROM v_task.assigned_agent_id
       OR v_tx.buyer_org_id IS DISTINCT FROM v_task.posted_by_org_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'no held payment matches this task for a quality issue';
    END IF;

    SELECT NOT EXISTS(SELECT 1 FROM quality_issues qi WHERE qi.task_id = p_task_id) INTO v_is_first;

    IF v_is_first THEN
        v_deadline := v_tx.review_deadline_at + INTERVAL '72 hours';
        UPDATE transactions tr SET review_deadline_at = v_deadline
         WHERE tr.id = v_tx.id AND tr.escrow_status = 'held';
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'transaction changed while opening quality issue';
        END IF;
    ELSE
        v_deadline := v_tx.review_deadline_at;
    END IF;

    INSERT INTO quality_issues(
        task_id, opened_by_org_id, assigned_agent_id, reason_code, initial_message, response_deadline_at
    ) VALUES (
        p_task_id, p_opened_by_org_id, v_task.assigned_agent_id, p_reason_code, BTRIM(p_initial_message), v_deadline
    ) RETURNING id INTO v_issue_id;

    INSERT INTO audit_logs(action, resource_type, resource_id, details)
    VALUES ('quality_issue_opened', 'task', p_task_id, jsonb_build_object(
      'quality_issue_id', v_issue_id, 'reason_code', p_reason_code, 'deadline_extended', v_is_first
    ));

    RETURN QUERY SELECT v_issue_id, 'open'::TEXT, v_deadline, v_is_first;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION open_quality_issue(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_quality_issue(UUID, UUID, TEXT, TEXT) TO service_role;

-- finalize_funded_task, re-defined to also add 'quality_issue_agent_refund'
-- is intentionally NOT a valid p_reason here — a task that completes
-- (buyer approves, or the deadline lapses) is finished, not refunded; see
-- finalize_task_refund below for the refund-side outcome. The only change
-- from migration 17 is the final UPDATE closing any still-open
-- quality_issue for this task as a side effect of the same finalization —
-- 'buyer_approved' and 'admin_dispute_pay_agent' both mean the work was
-- accepted, so they close it as 'buyer_approved'; the 48h auto-release
-- reason closes it as 'expired' (the objective fallback rule the parties
-- were told about before payment — see quality_issue_policy in the
-- discovery JSON and OpenAPI). A task with no open quality_issue is
-- unaffected — this UPDATE simply matches zero rows.
CREATE OR REPLACE FUNCTION finalize_funded_task(
  p_task_id UUID,
  p_transaction_id UUID,
  p_reason TEXT
) RETURNS TABLE (
  task_status TEXT,
  transaction_status TEXT,
  assigned_agent_id UUID,
  agent_payout_eur NUMERIC,
  platform_fee_eur NUMERIC,
  newly_completed BOOLEAN
) AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_tx transactions%ROWTYPE;
  v_new_score DOUBLE PRECISION;
  v_action TEXT;
BEGIN
  IF p_reason NOT IN ('buyer_approved', 'review_deadline_expired_48h', 'admin_dispute_pay_agent') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid finalization reason';
  END IF;

  SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found'; END IF;
  SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND OR v_tx.task_id IS DISTINCT FROM v_task.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
  END IF;

  IF v_task.status = 'completed' AND v_tx.escrow_status = 'released' THEN
    RETURN QUERY SELECT 'completed'::TEXT, 'released'::TEXT,
      v_task.assigned_agent_id, v_tx.agent_payout_eur, v_tx.platform_fee_eur, FALSE;
    RETURN;
  END IF;
  IF NOT (v_task.status = 'review' OR (p_reason = 'admin_dispute_pay_agent' AND v_task.status = 'disputed'))
     OR v_tx.escrow_status <> 'held'
     OR v_task.archived_at IS NOT NULL
     OR v_task.moderation_status <> 'approved'
     OR v_task.assigned_agent_id IS NULL
     OR v_tx.agent_id IS DISTINCT FROM v_task.assigned_agent_id
     OR v_tx.buyer_org_id IS DISTINCT FROM v_task.posted_by_org_id
     OR (p_reason = 'review_deadline_expired_48h'
         AND (v_tx.review_deadline_at IS NULL OR v_tx.review_deadline_at > CLOCK_TIMESTAMP())) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'funded task cannot be finalized from current state';
  END IF;

  UPDATE transactions tr
     SET escrow_status = 'released', released_at = COALESCE(tr.released_at, CLOCK_TIMESTAMP())
   WHERE tr.id = v_tx.id AND tr.escrow_status = 'held';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'transaction changed during finalization';
  END IF;
  UPDATE tasks t SET status = 'completed'
   WHERE t.id = v_task.id AND t.status = v_task.status;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task changed during finalization';
  END IF;

  SELECT LEAST(100.0, GREATEST(0.0, COALESCE(a.reputation_score, 50.0) + 8.0))
    INTO v_new_score FROM agents a WHERE a.id = v_task.assigned_agent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'assigned agent not found';
  END IF;
  UPDATE agents a
     SET reputation_score = v_new_score,
         tier = CASE WHEN v_new_score >= 90 THEN 4
                     WHEN v_new_score >= 75 THEN 3
                     WHEN v_new_score >= 60 THEN 2 ELSE 1 END,
         free_tasks_remaining = CASE
           WHEN v_tx.platform_fee_eur = 0 AND a.free_tasks_remaining > 0
             THEN a.free_tasks_remaining - 1
           ELSE a.free_tasks_remaining
         END
   WHERE a.id = v_task.assigned_agent_id;

  INSERT INTO reputation_events(agent_id, event_type, score_delta, task_id)
  VALUES (v_task.assigned_agent_id, 'task_completed', 8.0, v_task.id);

  v_action := CASE WHEN p_reason = 'buyer_approved' THEN 'task_approved_escrow_released'
                   WHEN p_reason = 'admin_dispute_pay_agent' THEN 'dispute_resolved'
                   ELSE 'escrow_auto_released' END;
  INSERT INTO audit_logs(action, resource_type, resource_id, details)
  VALUES (v_action, 'transaction', v_tx.id, jsonb_build_object(
    'task_id', v_task.id,
    'agent_payout_eur', v_tx.agent_payout_eur,
    'reason', p_reason
  ));

  UPDATE quality_issues
     SET status = CASE WHEN p_reason = 'review_deadline_expired_48h' THEN 'expired' ELSE 'buyer_approved' END,
         resolved_at = CLOCK_TIMESTAMP(),
         resolution = p_reason
   WHERE task_id = v_task.id AND status = 'open';

  RETURN QUERY SELECT 'completed'::TEXT, 'released'::TEXT,
    v_task.assigned_agent_id, v_tx.agent_payout_eur, v_tx.platform_fee_eur, TRUE;
END;
$$ LANGUAGE plpgsql;

-- finalize_task_refund, re-defined to accept the new
-- 'quality_issue_agent_refund' outcome (an agent's voluntary refund —
-- never a buyer or admin decision) and to close any still-open
-- quality_issue for the task, atomically, the same way described above.
-- 'quality_issue_agent_refund' maps to task status 'cancelled', exactly
-- like 'sla_missed' and 'admin_dispute_refund' — never 'disputed', which
-- was the old marketplace-dispute-specific status this flow deliberately
-- does not use.
CREATE OR REPLACE FUNCTION finalize_task_refund(
  p_task_id UUID,
  p_transaction_id UUID,
  p_outcome TEXT,
  p_reason TEXT
) RETURNS TABLE (task_status TEXT, transaction_status TEXT, newly_refunded BOOLEAN) AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_tx transactions%ROWTYPE;
  v_target_status TEXT;
  v_new_score DOUBLE PRECISION;
BEGIN
  IF p_outcome NOT IN ('buyer_refund', 'sla_missed', 'admin_dispute_refund', 'quality_issue_agent_refund') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid refund outcome';
  END IF;
  SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found'; END IF;
  SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND OR v_tx.task_id IS DISTINCT FROM v_task.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
  END IF;
  v_target_status := CASE WHEN p_outcome IN ('sla_missed','admin_dispute_refund','quality_issue_agent_refund') THEN 'cancelled' ELSE 'disputed' END;
  IF v_tx.escrow_status = 'refunded' AND v_task.status = v_target_status THEN
    RETURN QUERY SELECT v_target_status, 'refunded'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_tx.escrow_status <> 'held'
     OR v_task.status NOT IN ('assigned', 'in_progress', 'review', 'disputed')
     OR v_task.assigned_agent_id IS DISTINCT FROM v_tx.agent_id
     OR v_task.posted_by_org_id IS DISTINCT FROM v_tx.buyer_org_id
     OR (p_outcome = 'sla_missed' AND (
       v_task.status <> 'in_progress' OR v_task.delivery_deadline_at IS NULL
       OR v_task.delivery_deadline_at > CLOCK_TIMESTAMP()
     )) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'refund cannot be finalized from current state';
  END IF;

  UPDATE transactions SET escrow_status = 'refunded'
   WHERE id = v_tx.id AND escrow_status = 'held';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'transaction changed during refund'; END IF;
  UPDATE tasks SET status = v_target_status WHERE id = v_task.id AND status = v_task.status;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task changed during refund'; END IF;

  IF p_outcome = 'sla_missed' THEN
    SELECT LEAST(100.0, GREATEST(0.0, COALESCE(a.reputation_score, 50.0) - 5.0))
      INTO v_new_score FROM agents a WHERE a.id = v_task.assigned_agent_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'assigned agent not found'; END IF;
    UPDATE agents SET reputation_score = v_new_score,
      tier = CASE WHEN v_new_score >= 90 THEN 4 WHEN v_new_score >= 75 THEN 3
                  WHEN v_new_score >= 60 THEN 2 ELSE 1 END
     WHERE id = v_task.assigned_agent_id;
    INSERT INTO reputation_events(agent_id,event_type,score_delta,task_id)
    VALUES (v_task.assigned_agent_id,'task_failed',-5.0,v_task.id);
  END IF;

  INSERT INTO audit_logs(action,resource_type,resource_id,details)
  VALUES (CASE WHEN p_outcome='sla_missed' THEN 'sla_auto_refund'
               WHEN p_outcome='admin_dispute_refund' THEN 'dispute_resolved'
               WHEN p_outcome='quality_issue_agent_refund' THEN 'quality_issue_agent_refund'
               ELSE 'payment_refunded' END,
          'transaction',v_tx.id,jsonb_build_object(
            'task_id',v_task.id,'gross_amount_eur',v_tx.gross_amount_eur,
            'reason',LEFT(COALESCE(NULLIF(BTRIM(p_reason),''),'not specified'),1000)
          ));

  UPDATE quality_issues
     SET status = 'agent_refunded',
         resolved_at = CLOCK_TIMESTAMP(),
         resolution = p_outcome
   WHERE task_id = v_task.id AND status = 'open';

  RETURN QUERY SELECT v_target_status, 'refunded'::TEXT, TRUE;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION finalize_funded_task(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_funded_task(UUID, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION finalize_task_refund(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_task_refund(UUID, UUID, TEXT, TEXT) TO service_role;
