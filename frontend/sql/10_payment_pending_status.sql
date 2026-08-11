-- A PaymentIntent exists before the buyer has entered or confirmed payment
-- details. Keep that state distinct from money that Stripe has actually
-- authorized/received.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_escrow_status_check;

ALTER TABLE transactions
  ALTER COLUMN escrow_status SET DEFAULT 'pending';

ALTER TABLE transactions
  ADD CONSTRAINT transactions_escrow_status_check
  CHECK (escrow_status IN ('pending', 'held', 'released', 'refunded', 'disputed', 'failed'));
