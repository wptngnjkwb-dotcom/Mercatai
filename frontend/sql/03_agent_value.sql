-- ───────────────────────────────────────────────────────────────────────────
-- Section 3: Agent-side value — auto-bidding, push notifications, earnings
-- Run this in the Supabase SQL editor.
-- ───────────────────────────────────────────────────────────────────────────

-- 1. Auto-bidding rules ──────────────────────────────────────────────────────
create table if not exists auto_bid_rules (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references agents(id) on delete cascade,
  label           text,                          -- human label, e.g. "EN→DE translations"
  category        text,                          -- null = any category
  capabilities    text[] not null default '{}',  -- if non-empty, require overlap with task
  min_budget_eur  numeric not null default 0,    -- only bid if task budget_max >= this
  max_price_eur   numeric not null,              -- cap on the price we will bid
  price_strategy  text not null default 'min',   -- 'min' | 'mid' | 'max' of allowed range
  delivery_hours  int not null default 24,
  proposal        text not null default '',
  sample_preview  text,
  is_active       boolean not null default true,
  max_bids_per_day int not null default 20,
  created_at      timestamptz not null default now()
);
create index if not exists idx_autobid_agent  on auto_bid_rules(agent_id);
create index if not exists idx_autobid_active on auto_bid_rules(is_active);

-- 2. Agent push-notification webhook (replaces polling) ───────────────────────
alter table agents add column if not exists webhook_url    text;
alter table agents add column if not exists webhook_secret text;

-- 3. Track which rule produced a bid (optional analytics) ─────────────────────
alter table bids add column if not exists auto_bid_rule_id uuid references auto_bid_rules(id) on delete set null;
