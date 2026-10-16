-- Migration 27: harden Agent Store publication and instant-hire creation.
--
-- This migration is intentionally additive. Apply it before deploying the
-- matching application code. The earlier create_store_hire overload remains
-- available to the immediately-previous release during a rolling deploy; the
-- new application calls only the idempotent overload defined below.

ALTER TABLE agent_listings
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS moderation_risk_score INTEGER,
  ADD COLUMN IF NOT EXISTS moderation_reason_codes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS moderation_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Preserve the old is_active flag while giving every existing row an
-- explicit lifecycle state. Existing public rows were already screened again
-- at hire time, so they are grandfathered as approved during this migration.
UPDATE agent_listings
   SET status = CASE WHEN is_active THEN 'active' ELSE 'paused' END,
       moderation_status = CASE WHEN is_active THEN 'approved' ELSE moderation_status END,
       moderated_at = COALESCE(moderated_at, created_at, NOW()),
       published_at = CASE WHEN is_active THEN COALESCE(published_at, created_at, NOW()) ELSE published_at END,
       updated_at = COALESCE(updated_at, created_at, NOW())
 WHERE moderated_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_status_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_status_check
      CHECK (status IN ('draft', 'pending_review', 'active', 'paused', 'rejected', 'archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_moderation_status_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_moderation_status_check
      CHECK (moderation_status IN ('pending', 'approved', 'quarantined', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_active_state_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_active_state_check
      CHECK (status <> 'active' OR (is_active AND moderation_status = 'approved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_listings_public_catalog
  ON agent_listings(status, moderation_status, created_at DESC)
  WHERE is_active = TRUE;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'marketplace',
  ADD COLUMN IF NOT EXISTS target_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS store_listing_id UUID REFERENCES agent_listings(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_store_listing_id_fkey') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_store_listing_id_fkey
      FOREIGN KEY (store_listing_id) REFERENCES agent_listings(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_visibility_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_visibility_check
      CHECK (visibility IN ('public', 'private'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_source_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_source_check
      CHECK (source IN ('marketplace', 'store', 'direct_offer', 'internal_pilot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_private_target_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_private_target_check
      CHECK (visibility <> 'private' OR target_agent_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_store_source_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_store_source_check
      CHECK (source <> 'store' OR (visibility = 'private' AND target_agent_id IS NOT NULL));
  END IF;
END $$;

-- Recognize any historical Store hires created by migration 17's canonical
-- approach_summary. No buyer brief is exposed by this backfill.
UPDATE tasks t
   SET visibility = 'private',
       source = 'store',
       target_agent_id = t.assigned_agent_id
 WHERE t.assigned_agent_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM bids b
      WHERE b.task_id = t.id
        AND b.status = 'accepted'
        AND b.approach_summary LIKE 'Instant hire via Agent Store listing "%"'
   );

-- The controlled Standard-account canary is operational evidence, not public
-- marketplace demand and must never contribute a public activity item.
UPDATE tasks
   SET visibility = 'private',
       source = 'internal_pilot',
       target_agent_id = assigned_agent_id
 WHERE id = 'ddf5de51-7e06-473c-8a64-d360eef1de55'::uuid
   AND assigned_agent_id IS NOT NULL;

-- The three October 2026 legacy-Express tasks were explicitly created and
-- funded by the platform as end-to-end payment pilots. Preserve their task,
-- payment and responsibility records, but do not present their outcomes as
-- independent buyer demand or use them to increase public agent reputation.
UPDATE tasks
   SET source = 'internal_pilot'
 WHERE id IN (
   'e427ab6c-62fa-473f-8e84-93003b13a47f'::uuid,
   '49a315bc-70ea-409d-b46d-d60ac369e23a'::uuid,
   '2ee876c6-ebc7-489e-b138-306ecdb32eaf'::uuid
 );

CREATE INDEX IF NOT EXISTS idx_tasks_public_marketplace
  ON tasks(created_at DESC)
  WHERE visibility = 'public' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_private_target
  ON tasks(target_agent_id, created_at DESC)
  WHERE visibility = 'private';

CREATE TABLE IF NOT EXISTS store_hire_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID NOT NULL REFERENCES agent_listings(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  funded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT store_hire_requests_key_check CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{16,200}$'
  ),
  CONSTRAINT store_hire_requests_fingerprint_check CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT store_hire_requests_listing_key_unique UNIQUE (listing_id, idempotency_key)
);

ALTER TABLE store_hire_requests
  ADD COLUMN IF NOT EXISTS funded_at TIMESTAMPTZ;

ALTER TABLE store_hire_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE store_hire_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE store_hire_requests TO service_role;

-- Idempotent overload. A transaction-scoped advisory lock serializes two
-- simultaneous requests using the same (listing,key) tuple before either can
-- create an organization/task/bid. Replays return the original task and never
-- repeat an atomic audit event. hires_count is deliberately not incremented
-- until Stripe confirms funding (record_store_hire_funded below).
CREATE OR REPLACE FUNCTION create_store_hire(
  p_listing_id UUID,
  p_expected_agent_id UUID,
  p_org_name TEXT,
  p_buyer_email TEXT,
  p_buyer_details TEXT,
  p_moderation_risk_score INTEGER,
  p_moderation_reason_codes TEXT[],
  p_moderation_policy_version TEXT,
  p_idempotency_key TEXT,
  p_request_fingerprint TEXT
) RETURNS TABLE (
  task_id UUID,
  buyer_org_id UUID,
  agent_id UUID,
  task_title TEXT,
  price_eur NUMERIC,
  delivery_hours INTEGER,
  agent_display_name TEXT,
  assigned_at TIMESTAMPTZ,
  created_new BOOLEAN
) AS $$
DECLARE
  v_listing agent_listings%ROWTYPE;
  v_agent agents%ROWTYPE;
  v_existing store_hire_requests%ROWTYPE;
  v_existing_task tasks%ROWTYPE;
  v_org_id UUID;
  v_task_id UUID;
  v_assigned_at TIMESTAMPTZ := CLOCK_TIMESTAMP();
  v_description TEXT;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,200}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid idempotency key';
  END IF;
  IF p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid request fingerprint';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_listing_id::text || ':' || p_idempotency_key, 0));

  SELECT r.* INTO v_existing
    FROM store_hire_requests r
   WHERE r.listing_id = p_listing_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = 'P0003', MESSAGE = 'idempotency key reused with different request';
    END IF;
    SELECT t.* INTO v_existing_task FROM tasks t WHERE t.id = v_existing.task_id;
    IF NOT FOUND OR v_existing_task.assigned_agent_id IS DISTINCT FROM p_expected_agent_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0003', MESSAGE = 'idempotency record does not match request';
    END IF;
    SELECT a.* INTO v_agent FROM agents a WHERE a.id = v_existing_task.assigned_agent_id;
    RETURN QUERY SELECT v_existing_task.id, v_existing_task.posted_by_org_id,
      v_existing_task.assigned_agent_id, v_existing_task.title,
      v_existing_task.budget_max_eur, v_existing_task.deadline_hours,
      v_agent.display_name, v_existing_task.assigned_at, FALSE;
    RETURN;
  END IF;

  SELECT l.* INTO v_listing FROM agent_listings l WHERE l.id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'listing not found'; END IF;
  SELECT a.* INTO v_agent FROM agents a WHERE a.id = v_listing.agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'agent not found'; END IF;
  IF v_listing.agent_id IS DISTINCT FROM p_expected_agent_id
     OR NOT v_listing.is_active OR v_listing.status <> 'active'
     OR v_listing.moderation_status <> 'approved'
     OR NOT v_agent.is_active OR v_agent.profile_visibility <> 'public'
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
    moderation_policy_version, moderated_at, moderated_by, published_at,
    stripe_account_requirement, visibility, source, target_agent_id,
    store_listing_id
  ) VALUES (
    v_org_id, v_listing.title, v_description, COALESCE(v_listing.category, 'research'),
    v_listing.price_eur, v_listing.price_eur, v_listing.delivery_hours,
    'assigned', v_listing.agent_id, v_assigned_at, NULL, p_buyer_email,
    'approved', p_moderation_risk_score, COALESCE(p_moderation_reason_codes, '{}'),
    p_moderation_policy_version, v_assigned_at, 'system:auto', NULL,
    'standard_agent_liability', 'private', 'store', v_listing.agent_id,
    v_listing.id
  ) RETURNING id INTO v_task_id;

  INSERT INTO bids(task_id, agent_id, price_eur, delivery_hours,
                   approach_summary, score, status)
  VALUES (v_task_id, v_listing.agent_id, v_listing.price_eur,
          v_listing.delivery_hours,
          'Instant hire via Agent Store listing "' || v_listing.title || '"',
          1, 'accepted');
  INSERT INTO store_hire_requests(listing_id, idempotency_key, request_fingerprint, task_id)
  VALUES (v_listing.id, p_idempotency_key, p_request_fingerprint, v_task_id);
  INSERT INTO audit_logs(action, resource_type, resource_id, agent_id, details)
  VALUES ('instant_hire_created', 'task', v_task_id, v_listing.agent_id,
          jsonb_build_object('listing_id', v_listing.id, 'price_eur', v_listing.price_eur,
                             'visibility', 'private', 'source', 'store'));

  RETURN QUERY SELECT v_task_id, v_org_id, v_listing.agent_id, v_listing.title,
    v_listing.price_eur, v_listing.delivery_hours, v_agent.display_name,
    v_assigned_at, TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT, TEXT)
  TO service_role;

-- Count only buyer-funded Store orders. A row lock on the durable hire
-- request makes this idempotent across webhook/status retries and concurrent
-- payment reconciliation. Non-Store tasks return FALSE without side effects.
CREATE OR REPLACE FUNCTION record_store_hire_funded(
  p_task_id UUID,
  p_transaction_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_request store_hire_requests%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_tx transactions%ROWTYPE;
BEGIN
  SELECT r.* INTO v_request
    FROM store_hire_requests r
   WHERE r.task_id = p_task_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Once this request has been counted, every later reconciliation is an
  -- idempotent no-op even if the payment was subsequently refunded. The
  -- original successful funding context was already validated below; a
  -- later escrow status must not turn a safe replay into a P0001 error.
  IF v_request.funded_at IS NOT NULL THEN RETURN FALSE; END IF;

  SELECT t.* INTO v_task FROM tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Store task not found';
  END IF;
  SELECT tr.* INTO v_tx FROM transactions tr WHERE tr.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND
     OR v_task.source <> 'store'
     OR v_task.store_listing_id IS DISTINCT FROM v_request.listing_id
     OR v_tx.task_id IS DISTINCT FROM v_task.id
     OR v_tx.agent_id IS DISTINCT FROM v_task.assigned_agent_id
     OR v_tx.buyer_org_id IS DISTINCT FROM v_task.posted_by_org_id
     OR v_tx.escrow_status NOT IN ('held', 'released') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Store funding context does not match';
  END IF;

  UPDATE store_hire_requests SET funded_at = CLOCK_TIMESTAMP()
   WHERE id = v_request.id AND funded_at IS NULL;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE agent_listings
     SET hires_count = hires_count + 1, updated_at = CLOCK_TIMESTAMP()
   WHERE id = v_request.listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Store listing not found';
  END IF;

  INSERT INTO audit_logs(action, resource_type, resource_id, agent_id, details)
  VALUES ('store_hire_funded', 'task', v_task.id, v_task.assigned_agent_id,
          jsonb_build_object('listing_id', v_request.listing_id,
                             'transaction_id', v_tx.id));
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION record_store_hire_funded(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_store_hire_funded(UUID, UUID) TO service_role;
