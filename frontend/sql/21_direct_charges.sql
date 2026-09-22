-- Migration 21: immutable Stripe charge context for Direct Charges.
--
-- New payments are created directly on the assigned agent's connected
-- account. Mercatai receives only application_fee_amount. Existing
-- destination-charge PaymentIntents remain readable/refundable under their
-- original platform-account context.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS stripe_charge_model TEXT,
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT;

UPDATE transactions
   SET stripe_charge_model = 'destination'
 WHERE stripe_charge_model IS NULL
   AND stripe_payment_intent_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_stripe_charge_model_check'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_stripe_charge_model_check
      CHECK (stripe_charge_model IS NULL OR stripe_charge_model IN ('destination', 'direct'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_stripe_charge_context_check'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_stripe_charge_context_check
      CHECK (
        stripe_charge_model IS NULL
        OR (stripe_charge_model = 'destination' AND stripe_connected_account_id IS NULL)
        OR (stripe_charge_model = 'direct' AND stripe_connected_account_id ~ '^acct_')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_stripe_connected_account
  ON transactions(stripe_connected_account_id)
  WHERE stripe_connected_account_id IS NOT NULL;

ALTER TABLE payment_disputes
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT;

-- Freezes the Stripe account namespace before a PaymentIntent is created.
-- A retry may repeat the same values; a different model/account is rejected.
CREATE OR REPLACE FUNCTION bind_payment_charge_context(
  p_transaction_id UUID,
  p_charge_model TEXT,
  p_stripe_connected_account_id TEXT
) RETURNS TABLE (
  stripe_charge_model TEXT,
  stripe_connected_account_id TEXT
) AS $$
DECLARE
  v_tx transactions%ROWTYPE;
BEGIN
  IF p_charge_model NOT IN ('destination', 'direct') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Stripe charge model';
  END IF;
  IF p_charge_model = 'direct' AND (p_stripe_connected_account_id IS NULL OR p_stripe_connected_account_id !~ '^acct_') THEN
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

  UPDATE transactions AS tx
     SET stripe_charge_model = COALESCE(tx.stripe_charge_model, p_charge_model),
         stripe_connected_account_id = COALESCE(tx.stripe_connected_account_id, p_stripe_connected_account_id)
   WHERE tx.id = p_transaction_id;

  RETURN QUERY
  SELECT t.stripe_charge_model, t.stripe_connected_account_id
    FROM transactions t WHERE t.id = p_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- Direct charges have no Transfer object: the Charge is born in the
-- connected account. Destination charges retain migration 20's transfer-id
-- invariant. Both models freeze the account/model alongside charge identity.
CREATE OR REPLACE FUNCTION record_payment_charge_identity_v2(
  p_transaction_id UUID,
  p_stripe_payment_intent_id TEXT,
  p_stripe_charge_id TEXT,
  p_stripe_transfer_id TEXT,
  p_charge_model TEXT,
  p_stripe_connected_account_id TEXT
) RETURNS TABLE (
  stripe_charge_id TEXT,
  stripe_transfer_id TEXT,
  charge_id_conflict BOOLEAN,
  transfer_id_conflict BOOLEAN
) AS $$
DECLARE
  v_tx transactions%ROWTYPE;
  v_charge_conflict BOOLEAN;
  v_transfer_conflict BOOLEAN;
BEGIN
  SELECT * INTO v_tx FROM transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'transaction not found';
  END IF;
  IF v_tx.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'payment intent mismatch';
  END IF;
  IF v_tx.stripe_charge_model IS DISTINCT FROM p_charge_model
     OR v_tx.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Stripe charge context mismatch';
  END IF;

  v_charge_conflict := v_tx.stripe_charge_id IS NOT NULL
    AND v_tx.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id;
  v_transfer_conflict := p_stripe_transfer_id IS NOT NULL
    AND v_tx.stripe_transfer_id IS NOT NULL
    AND v_tx.stripe_transfer_id IS DISTINCT FROM p_stripe_transfer_id;

  IF NOT v_charge_conflict AND NOT v_transfer_conflict THEN
    UPDATE transactions AS tx
       SET stripe_charge_id = COALESCE(tx.stripe_charge_id, p_stripe_charge_id),
           stripe_transfer_id = COALESCE(tx.stripe_transfer_id, p_stripe_transfer_id)
     WHERE tx.id = p_transaction_id;
  ELSE
    INSERT INTO audit_logs(action, resource_type, resource_id, details)
    VALUES ('payment_identity_mismatch', 'transaction', p_transaction_id,
      jsonb_build_object(
        'stripe_payment_intent_id', p_stripe_payment_intent_id,
        'stored_charge_id', v_tx.stripe_charge_id,
        'observed_charge_id', p_stripe_charge_id,
        'stored_transfer_id', v_tx.stripe_transfer_id,
        'observed_transfer_id', p_stripe_transfer_id,
        'charge_model', p_charge_model,
        'stripe_connected_account_id', p_stripe_connected_account_id
      ));
  END IF;

  RETURN QUERY SELECT t.stripe_charge_id, t.stripe_transfer_id,
    v_charge_conflict, v_transfer_conflict
    FROM transactions t WHERE t.id = p_transaction_id;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION bind_payment_charge_context(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_payment_charge_identity_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bind_payment_charge_context(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION record_payment_charge_identity_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
