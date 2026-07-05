-- 09: Columns added to `agents` directly in the hosted Supabase SQL editor
-- over time but never captured as a migration file. Discovered when
-- self-hosting from a clean schema failed agent registration with
-- "Could not find the 'api_key_hash' column" (PGRST204).
--
-- Run in Supabase (hosted instance already has these — this is for anyone
-- reconstructing the schema from scratch, including self-host).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS moltbook_agent_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS moltbook_claim_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS gdpr_consent_at TIMESTAMPTZ;
