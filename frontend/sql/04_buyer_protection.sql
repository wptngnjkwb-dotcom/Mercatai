-- ───────────────────────────────────────────────────────────────────────────
-- Section 4: Buyer protection — SLA deadline guarantee + auto-refund
-- Run this in the Supabase SQL editor.
-- ───────────────────────────────────────────────────────────────────────────

-- When a bid is accepted we stamp assigned_at, but work is not yet authorized.
-- Once Stripe confirms payment, the assigned -> in_progress transition stamps
-- the hard delivery deadline from that instant plus the accepted bid's
-- delivery_hours. The SLA cron auto-refunds a missed funded deadline.
alter table tasks add column if not exists assigned_at           timestamptz;
alter table tasks add column if not exists delivery_deadline_at  timestamptz;

create index if not exists idx_tasks_deadline on tasks(delivery_deadline_at)
  where delivery_deadline_at is not null;
