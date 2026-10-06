-- Migration 24: make Stripe Standard/full-dashboard accounts the default
-- for every new marketplace payment while preserving the three explicitly
-- approved October 2026 pilot tasks on the legacy Express configuration.
--
-- Existing `agents.stripe_account_id` rows are legacy Express accounts.
-- They are intentionally retained in place so the three pilot tasks can use
-- them. New Standard accounts are stored separately and can never silently
-- replace or reuse a legacy Express account.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS stripe_standard_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_standard_onboarding_completed BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS agents_stripe_standard_account_id_key
  ON agents(stripe_standard_account_id)
  WHERE stripe_standard_account_id IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS stripe_account_requirement TEXT NOT NULL
    DEFAULT 'standard_agent_liability';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tasks_stripe_account_requirement_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_stripe_account_requirement_check
      CHECK (stripe_account_requirement IN (
        'standard_agent_liability',
        'legacy_express_platform_liability'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tasks_legacy_express_pilot_only_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_legacy_express_pilot_only_check
      CHECK (
        stripe_account_requirement <> 'legacy_express_platform_liability'
        OR id IN (
          'e427ab6c-62fa-473f-8e84-93003b13a47f'::uuid,
          '49a315bc-70ea-409d-b46d-d60ac369e23a'::uuid,
          '2ee876c6-ebc7-489e-b138-306ecdb32eaf'::uuid
        )
      );
  END IF;
END $$;

-- These are the only production tasks authorised to use the legacy Express
-- liability model. The UPDATE is harmless on fresh/self-hosted installs
-- where these production UUIDs do not exist.
UPDATE tasks
   SET stripe_account_requirement = 'legacy_express_platform_liability'
 WHERE id IN (
   'e427ab6c-62fa-473f-8e84-93003b13a47f'::uuid,
   '49a315bc-70ea-409d-b46d-d60ac369e23a'::uuid,
   '2ee876c6-ebc7-489e-b138-306ecdb32eaf'::uuid
 );

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS stripe_account_requirement TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'transactions_stripe_account_requirement_check'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_stripe_account_requirement_check
      CHECK (stripe_account_requirement IS NULL OR stripe_account_requirement IN (
        'standard_agent_liability',
        'legacy_express_platform_liability'
      ));
  END IF;
END $$;

-- Freeze charge namespace AND responsibility model before creating a Stripe
-- object. Retries may repeat the same tuple but can never change it.
CREATE OR REPLACE FUNCTION bind_payment_charge_context_v2(
  p_transaction_id UUID,
  p_charge_model TEXT,
  p_stripe_connected_account_id TEXT,
  p_stripe_account_requirement TEXT
) RETURNS TABLE (
  stripe_charge_model TEXT,
  stripe_connected_account_id TEXT,
  stripe_account_requirement TEXT
) AS $$
DECLARE
  v_tx transactions%ROWTYPE;
BEGIN
  IF p_charge_model NOT IN ('destination', 'direct') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Stripe charge model';
  END IF;
  IF p_stripe_account_requirement NOT IN (
    'standard_agent_liability',
    'legacy_express_platform_liability'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Stripe account requirement';
  END IF;
  IF p_charge_model = 'direct'
     AND (p_stripe_connected_account_id IS NULL OR p_stripe_connected_account_id !~ '^acct_') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'direct charge requires a connected account';
  END IF;
  IF p_charge_model = 'destination' AND p_stripe_connected_account_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'destination charge must use the platform account namespace';
  END IF;

  SELECT * INTO v_tx FROM transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
  END IF;
  IF v_tx.stripe_charge_model IS NOT NULL
     AND v_tx.stripe_charge_model IS DISTINCT FROM p_charge_model THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Stripe charge model is immutable';
  END IF;
  IF v_tx.stripe_connected_account_id IS NOT NULL
     AND v_tx.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Stripe connected account is immutable';
  END IF;
  IF v_tx.stripe_account_requirement IS NOT NULL
     AND v_tx.stripe_account_requirement IS DISTINCT FROM p_stripe_account_requirement THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Stripe account requirement is immutable';
  END IF;

  UPDATE transactions AS tx
     SET stripe_charge_model = COALESCE(tx.stripe_charge_model, p_charge_model),
         stripe_connected_account_id = COALESCE(tx.stripe_connected_account_id, p_stripe_connected_account_id),
         stripe_account_requirement = COALESCE(tx.stripe_account_requirement, p_stripe_account_requirement)
   WHERE tx.id = p_transaction_id;

  RETURN QUERY
  SELECT t.stripe_charge_model, t.stripe_connected_account_id, t.stripe_account_requirement
    FROM transactions t WHERE t.id = p_transaction_id;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION bind_payment_charge_context_v2(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bind_payment_charge_context_v2(UUID, TEXT, TEXT, TEXT)
  TO service_role;
