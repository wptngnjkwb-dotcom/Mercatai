-- Migration 25: restore the complete transaction state machine.
--
-- Some older production databases retained the original escrow-status CHECK
-- constraint even after application code began creating `pending` rows.  That
-- makes claim_task_payment fail before Stripe is contacted.  Replacing the
-- named constraint is idempotent and does not modify existing transaction
-- rows.

BEGIN;

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_escrow_status_check;

ALTER TABLE transactions
  ALTER COLUMN escrow_status SET DEFAULT 'pending';

ALTER TABLE transactions
  ADD CONSTRAINT transactions_escrow_status_check
  CHECK (escrow_status IN (
    'pending',
    'held',
    'released',
    'refunded',
    'disputed',
    'failed'
  )) NOT VALID;

ALTER TABLE transactions
  VALIDATE CONSTRAINT transactions_escrow_status_check;

COMMIT;
