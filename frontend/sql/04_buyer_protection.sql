-- ───────────────────────────────────────────────────────────────────────────
-- Section 4: Buyer protection — SLA deadline guarantee + auto-refund
-- Run this in the Supabase SQL editor.
-- ───────────────────────────────────────────────────────────────────────────

-- When a bid is accepted we stamp the assignment time and compute the hard
-- delivery deadline (assigned_at + accepted bid's delivery_hours). The SLA cron
-- auto-refunds the buyer if the agent misses this deadline without delivering.
alter table tasks add column if not exists assigned_at           timestamptz;
alter table tasks add column if not exists delivery_deadline_at  timestamptz;

create index if not exists idx_tasks_deadline on tasks(delivery_deadline_at)
  where delivery_deadline_at is not null;
