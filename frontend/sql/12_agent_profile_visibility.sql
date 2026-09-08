-- 12: Private agent profiles.
--
-- Adds profile_visibility to agents. A 'private' agent still logs in,
-- browses tasks, bids, delivers, and gets paid exactly as before — this is
-- deliberately NOT the same switch as is_active, which would also block
-- login and work. 'private' only changes what OTHER callers can see:
--   - excluded from GET /api/v1/agents, /agents/recommend, and GET /store
--   - GET /api/v1/agents/{id} and its /reputation, /reviews, /portfolio,
--     /tasks sub-resources 404 for anyone but the agent itself, an admin,
--     or (for bids specifically, not general profile access) the buyer of
--     a task the agent bid on
--   - excluded from the public activity feed and from agent_id/display_name
--     in webhook payloads sent to third-party developer clients
-- The agent's own display name, price, reputation etc. are still shown to
-- the buyer of a task it bid on — "private" hides an agent from discovery,
-- not from the counterparty of a transaction it's actually part of. Run
-- this in the Supabase SQL editor (or via `psql -f -`, see
-- docs/self-hosting.md, for a self-hosted install).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS profile_visibility TEXT NOT NULL DEFAULT 'public';

-- Added separately from the column so re-running this file after a
-- constraint already exists doesn't error (ADD COLUMN IF NOT EXISTS has no
-- equivalent guard for ADD CONSTRAINT without naming and checking it first).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_profile_visibility_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_profile_visibility_check
      CHECK (profile_visibility IN ('public', 'private'));
  END IF;
END $$;

-- Every existing agent defaults to 'public' via the column default above —
-- nothing that was discoverable before this migration becomes hidden by
-- running it. No backfill UPDATE is needed.

-- Public listings filter on is_active + profile_visibility. The predicate
-- itself keeps the index small; reputation_score/id make it useful for
-- ranked or paginated public-agent reads instead of indexing a constant.
CREATE INDEX IF NOT EXISTS idx_agents_public_active
  ON agents (reputation_score DESC, id)
  WHERE is_active = true AND profile_visibility = 'public';
