-- 17: payment-integrity hardening.
-- Run after 16_atomic_task_delivery.sql. Idempotent and non-destructive.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS payment_attempt_key UUID NOT NULL DEFAULT uuid_generate_v4(),
  ADD COLUMN IF NOT EXISTS payment_method TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'transactions_payment_method_check'
       AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('card', 'sepa_debit')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bids_delivery_hours_valid'
       AND conrelid = 'bids'::regclass
  ) THEN
    -- NOT VALID avoids rewriting or silently changing historical rows, while
    -- still rejecting every invalid bid inserted after this migration.
    ALTER TABLE bids ADD CONSTRAINT bids_delivery_hours_valid
      CHECK (delivery_hours BETWEEN 1 AND 8760) NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_payment_attempt_key
  ON transactions(payment_attempt_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_stripe_payment_intent
  ON transactions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_one_active_per_task
  ON transactions(task_id)
  WHERE escrow_status IN ('pending', 'held');
CREATE UNIQUE INDEX IF NOT EXISTS uq_bids_one_accepted_per_task
  ON bids(task_id)
  WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_transactions_task_created
  ON transactions(task_id, created_at DESC, id DESC);

-- Selects exactly one bid and task assignment in one transaction. The task
-- lock serializes competing selections before either request locks its own bid,
-- avoiding a bidA/task vs bidB/task deadlock.
CREATE OR REPLACE FUNCTION accept_task_bid(
  p_bid_id UUID,
  p_expected_task_id UUID
) RETURNS TABLE (
  bid_id UUID,
  task_id UUID,
  agent_id UUID,
  price_eur NUMERIC,
  delivery_hours INTEGER,
  task_status TEXT,
  assigned_at TIMESTAMPTZ
) AS $$
DECLARE
  v_bid_task_id UUID;
  v_bid bids%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_assigned_at TIMESTAMPTZ;
BEGIN
  SELECT b.task_id INTO v_bid_task_id FROM bids b WHERE b.id = p_bid_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'bid not found';
  END IF;
  IF v_bid_task_id IS DISTINCT FROM p_expected_task_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'bid does not belong to authorized task';
  END IF;

  SELECT t.* INTO v_task FROM tasks t WHERE t.id = v_bid_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found';
  END IF;

  SELECT b.* INTO v_bid FROM bids b WHERE b.id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'bid not found';
  END IF;

  IF v_task.status NOT IN ('open', 'bidding')
     OR v_task.moderation_status <> 'approved'
     OR v_task.archived_at IS NOT NULL
     OR v_bid.status <> 'pending'
     OR v_bid.task_id IS DISTINCT FROM v_task.id
     OR v_bid.delivery_hours NOT BETWEEN 1 AND 8760
     OR v_bid.price_eur <= 0
     OR EXISTS (
       SELECT 1 FROM organizations o
        WHERE o.id = v_task.posted_by_org_id AND o.is_platform_seed = TRUE
     )
     OR EXISTS (
       SELECT 1 FROM transactions tr
        WHERE tr.task_id = v_task.id
          AND tr.escrow_status IN ('pending', 'held', 'released')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'bid selection is not authorized for current task state';
  END IF;

  v_assigned_at := CLOCK_TIMESTAMP();
  UPDATE tasks t
     SET status = 'assigned',
         assigned_agent_id = v_bid.agent_id,
         assigned_at = v_assigned_at,
         delivery_deadline_at = NULL
   WHERE t.id = v_task.id AND t.status IN ('open', 'bidding');
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task changed during bid selection';
  END IF;

  UPDATE bids b SET status = 'accepted'
   WHERE b.id = v_bid.id AND b.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'bid changed during selection';
  END IF;

  UPDATE bids b SET status = 'rejected'
   WHERE b.task_id = v_task.id AND b.id <> v_bid.id AND b.status = 'pending';

  RETURN QUERY SELECT v_bid.id, v_task.id, v_bid.agent_id, v_bid.price_eur,
                      v_bid.delivery_hours, 'assigned'::TEXT, v_assigned_at;
END;
$$ LANGUAGE plpgsql;

-- Claims or resumes the one active payment attempt for a selected bid. The
-- Stripe PaymentIntent is created afterwards with payment_attempt_key as its
-- idempotency key; concurrent callers therefore converge on one DB row and one
-- Stripe object.
CREATE OR REPLACE FUNCTION claim_task_payment(
  p_task_id UUID,
  p_buyer_org_id UUID,
  p_agent_id UUID,
  p_accepted_bid_id UUID,
  p_payment_method TEXT,
  p_gross_amount_eur NUMERIC,
  p_platform_fee_eur NUMERIC,
  p_processing_deduction_eur NUMERIC,
  p_agent_payout_eur NUMERIC
) RETURNS TABLE (
  transaction_id UUID,
  payment_attempt_key UUID,
  stripe_payment_intent_id TEXT,
  escrow_status TEXT,
  payment_method TEXT,
  gross_amount_eur NUMERIC,
  platform_fee_eur NUMERIC,
  processing_deduction_eur NUMERIC,
  agent_payout_eur NUMERIC,
  created BOOLEAN
) AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_bid bids%ROWTYPE;
  v_tx transactions%ROWTYPE;
BEGIN
  SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found';
  END IF;
  SELECT b.* INTO v_bid FROM bids b WHERE b.id = p_accepted_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'accepted bid not found';
  END IF;

  IF p_payment_method IS NULL OR p_payment_method NOT IN ('card', 'sepa_debit')
     OR v_task.status <> 'assigned'
     OR v_task.moderation_status <> 'approved'
     OR v_task.archived_at IS NOT NULL
     OR v_task.assigned_agent_id IS DISTINCT FROM p_agent_id
     OR v_task.posted_by_org_id IS DISTINCT FROM p_buyer_org_id
     OR v_bid.task_id IS DISTINCT FROM v_task.id
     OR v_bid.agent_id IS DISTINCT FROM v_task.assigned_agent_id
     OR v_bid.status <> 'accepted'
     OR v_bid.price_eur IS DISTINCT FROM p_gross_amount_eur
     OR v_bid.delivery_hours NOT BETWEEN 1 AND 8760
     OR (p_payment_method = 'card' AND v_bid.delivery_hours > 96)
     OR p_gross_amount_eur <= 0
     OR p_platform_fee_eur < 0
     OR p_processing_deduction_eur < 0
     OR p_agent_payout_eur < 0
     OR ROUND(p_platform_fee_eur + p_processing_deduction_eur + p_agent_payout_eur, 2)
        IS DISTINCT FROM ROUND(p_gross_amount_eur, 2)
     OR EXISTS (
       SELECT 1 FROM organizations o
        WHERE o.id = v_task.posted_by_org_id AND o.is_platform_seed = TRUE
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'payment is not authorized for current task and bid state';
  END IF;

  SELECT tr.* INTO v_tx
    FROM transactions tr
   WHERE tr.task_id = p_task_id
     AND tr.escrow_status IN ('pending', 'held', 'released')
   ORDER BY tr.created_at DESC NULLS LAST, tr.id DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    IF v_tx.escrow_status <> 'pending'
       OR v_tx.agent_id IS DISTINCT FROM p_agent_id
       OR v_tx.buyer_org_id IS DISTINCT FROM p_buyer_org_id
       OR v_tx.payment_method IS DISTINCT FROM p_payment_method
       OR v_tx.gross_amount_eur IS DISTINCT FROM p_gross_amount_eur THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'an incompatible or funded payment already exists';
    END IF;
    RETURN QUERY SELECT v_tx.id, v_tx.payment_attempt_key,
                        v_tx.stripe_payment_intent_id, v_tx.escrow_status,
                        v_tx.payment_method, v_tx.gross_amount_eur,
                        v_tx.platform_fee_eur, v_tx.stripe_fee_eur,
                        v_tx.agent_payout_eur, FALSE;
    RETURN;
  END IF;

  INSERT INTO transactions(
    task_id, buyer_org_id, agent_id, gross_amount_eur, platform_fee_eur,
    stripe_fee_eur, agent_payout_eur, escrow_status, review_deadline_at,
    payment_method
  ) VALUES (
    p_task_id, p_buyer_org_id, p_agent_id, p_gross_amount_eur,
    p_platform_fee_eur, p_processing_deduction_eur, p_agent_payout_eur,
    'pending', NULL, p_payment_method
  ) RETURNING * INTO v_tx;

  RETURN QUERY SELECT v_tx.id, v_tx.payment_attempt_key,
                      v_tx.stripe_payment_intent_id, v_tx.escrow_status,
                      v_tx.payment_method, v_tx.gross_amount_eur,
                      v_tx.platform_fee_eur, v_tx.stripe_fee_eur,
                      v_tx.agent_payout_eur, TRUE;
END;
$$ LANGUAGE plpgsql;

-- Replaces migration 16's definition with the additional invariant that the
-- transaction/Stripe destination belongs to the currently assigned agent and
-- buyer organization.
CREATE OR REPLACE FUNCTION submit_funded_task_delivery(
  p_task_id UUID,
  p_expected_agent_id UUID,
  p_delivery_note TEXT
) RETURNS TABLE (task_id UUID, task_status TEXT, review_deadline_at TIMESTAMPTZ) AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_transaction transactions%ROWTYPE;
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
     OR v_task.moderation_status <> 'approved'
     OR v_task.status <> 'in_progress'
     OR v_task.assigned_agent_id IS DISTINCT FROM p_expected_agent_id
     OR EXISTS (
       SELECT 1 FROM organizations o
        WHERE o.id = v_task.posted_by_org_id AND o.is_platform_seed = TRUE
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'task execution is not authorized';
  END IF;

  SELECT tr.* INTO v_transaction
    FROM transactions tr
   WHERE tr.task_id = p_task_id
   ORDER BY tr.created_at DESC NULLS LAST, tr.id DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND OR v_transaction.escrow_status <> 'held'
     OR v_transaction.agent_id IS DISTINCT FROM v_task.assigned_agent_id
     OR v_transaction.buyer_org_id IS DISTINCT FROM v_task.posted_by_org_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'funded transaction does not match task assignment';
  END IF;

  v_review_deadline := CLOCK_TIMESTAMP() + INTERVAL '48 hours';
  UPDATE transactions tr SET review_deadline_at = v_review_deadline
   WHERE tr.id = v_transaction.id AND tr.escrow_status = 'held';
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

-- Stripe can cancel a previously authorized card (for example when its
-- capture window expires). Once Stripe's live API confirms that state, stop
-- execution atomically; never leave Mercatai claiming the task is funded.
CREATE OR REPLACE FUNCTION invalidate_task_funding(
  p_transaction_id UUID,
  p_task_id UUID
) RETURNS TABLE (task_status TEXT, transaction_status TEXT) AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_tx transactions%ROWTYPE;
  v_next_task_status TEXT;
BEGIN
  SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found'; END IF;
  SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND OR v_tx.task_id IS DISTINCT FROM v_task.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
  END IF;

  IF v_tx.escrow_status = 'failed' THEN
    RETURN QUERY SELECT v_task.status, 'failed'::TEXT;
    RETURN;
  END IF;
  IF v_tx.escrow_status NOT IN ('pending', 'held') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'final transaction cannot be invalidated';
  END IF;
  IF v_task.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'final task requires manual reconciliation';
  END IF;

  v_next_task_status := CASE
    WHEN v_task.status = 'review' THEN 'disputed'
    WHEN v_task.status IN ('assigned', 'in_progress') THEN 'assigned'
    ELSE v_task.status
  END;

  UPDATE transactions SET escrow_status = 'failed' WHERE id = v_tx.id;
  UPDATE tasks SET status = v_next_task_status,
                   delivery_deadline_at = CASE WHEN v_next_task_status = 'assigned' THEN NULL ELSE delivery_deadline_at END
   WHERE id = v_task.id;
  RETURN QUERY SELECT v_next_task_status, 'failed'::TEXT;
END;
$$ LANGUAGE plpgsql;

-- Finalizes buyer approval or the 48-hour auto-release as one database
-- transaction. Stripe capture happens first; if this RPC then fails, a retry
-- observes Stripe=succeeded and safely retries only this atomic finalization.
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

  RETURN QUERY SELECT 'completed'::TEXT, 'released'::TEXT,
    v_task.assigned_agent_id, v_tx.agent_payout_eur, v_tx.platform_fee_eur, TRUE;
END;
$$ LANGUAGE plpgsql;

-- Creates an instant Store hire (buyer organization, assigned task, accepted
-- bid and listing counter) atomically. A failed bid insert can therefore
-- never leave an assigned task which cannot be funded or executed.
CREATE OR REPLACE FUNCTION create_store_hire(
  p_listing_id UUID,
  p_expected_agent_id UUID,
  p_org_name TEXT,
  p_buyer_email TEXT,
  p_buyer_details TEXT,
  p_moderation_risk_score INTEGER,
  p_moderation_reason_codes TEXT[],
  p_moderation_policy_version TEXT
) RETURNS TABLE (
  task_id UUID,
  buyer_org_id UUID,
  agent_id UUID,
  task_title TEXT,
  price_eur NUMERIC,
  delivery_hours INTEGER,
  agent_display_name TEXT,
  assigned_at TIMESTAMPTZ
) AS $$
DECLARE
  v_listing agent_listings%ROWTYPE;
  v_agent agents%ROWTYPE;
  v_org_id UUID;
  v_task_id UUID;
  v_assigned_at TIMESTAMPTZ := CLOCK_TIMESTAMP();
  v_description TEXT;
BEGIN
  SELECT l.* INTO v_listing FROM agent_listings l WHERE l.id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'listing not found'; END IF;
  SELECT a.* INTO v_agent FROM agents a WHERE a.id = v_listing.agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'agent not found'; END IF;
  IF v_listing.agent_id IS DISTINCT FROM p_expected_agent_id
     OR NOT v_listing.is_active OR NOT v_agent.is_active
     OR v_agent.profile_visibility <> 'public'
     OR v_listing.price_eur < 1 OR v_listing.price_eur > 10000
     OR v_listing.delivery_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'listing cannot be hired';
  END IF;

  INSERT INTO organizations(name, verification_level)
  VALUES (COALESCE(NULLIF(BTRIM(p_org_name), ''), 'anonymous'), 'anonymous')
  RETURNING id INTO v_org_id;
  v_description := v_listing.description || CASE
    WHEN p_buyer_details IS NULL OR BTRIM(p_buyer_details) = '' THEN ''
    ELSE E'\n\n--- Buyer brief ---\n' || BTRIM(p_buyer_details) END;

  INSERT INTO tasks(
    posted_by_org_id, title, description, category, budget_min_eur,
    budget_max_eur, deadline_hours, status, assigned_agent_id, assigned_at,
    delivery_deadline_at, buyer_email, moderation_status,
    moderation_risk_score, moderation_reason_codes,
    moderation_policy_version, moderated_at, moderated_by, published_at
  ) VALUES (
    v_org_id, v_listing.title, v_description, COALESCE(v_listing.category, 'research'),
    v_listing.price_eur, v_listing.price_eur, v_listing.delivery_hours,
    'assigned', v_listing.agent_id, v_assigned_at, NULL, p_buyer_email,
    'approved', p_moderation_risk_score, COALESCE(p_moderation_reason_codes, '{}'),
    p_moderation_policy_version, v_assigned_at, 'system:auto', v_assigned_at
  ) RETURNING id INTO v_task_id;

  INSERT INTO bids(task_id, agent_id, price_eur, delivery_hours,
                   approach_summary, score, status)
  VALUES (v_task_id, v_listing.agent_id, v_listing.price_eur,
          v_listing.delivery_hours,
          'Instant hire via Agent Store listing "' || v_listing.title || '"',
          1, 'accepted');
  UPDATE agent_listings SET hires_count = hires_count + 1 WHERE id = v_listing.id;

  RETURN QUERY SELECT v_task_id, v_org_id, v_listing.agent_id, v_listing.title,
    v_listing.price_eur, v_listing.delivery_hours, v_agent.display_name, v_assigned_at;
END;
$$ LANGUAGE plpgsql;

-- Persists a Stripe-confirmed refund/cancellation and its task outcome in one
-- transaction. The caller uses a stable Stripe idempotency key before this
-- RPC, so a DB retry cannot create a second monetary refund.
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
  IF p_outcome NOT IN ('buyer_refund', 'sla_missed', 'admin_dispute_refund') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid refund outcome';
  END IF;
  SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'task not found'; END IF;
  SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND OR v_tx.task_id IS DISTINCT FROM v_task.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
  END IF;
  v_target_status := CASE WHEN p_outcome IN ('sla_missed','admin_dispute_refund') THEN 'cancelled' ELSE 'disputed' END;
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
               ELSE 'payment_refunded' END,
          'transaction',v_tx.id,jsonb_build_object(
            'task_id',v_task.id,'gross_amount_eur',v_tx.gross_amount_eur,
            'reason',LEFT(COALESCE(NULLIF(BTRIM(p_reason),''),'not specified'),1000)
          ));
  RETURN QUERY SELECT v_target_status, 'refunded'::TEXT, TRUE;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION accept_task_bid(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_task_payment(UUID, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION invalidate_task_funding(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_funded_task(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_task_refund(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_task_bid(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION claim_task_payment(UUID, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION submit_funded_task_delivery(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION invalidate_task_funding(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_funded_task(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_task_refund(UUID, UUID, TEXT, TEXT) TO service_role;
