-- 26: Recover lost agent API keys without creating duplicate agents, revoke
-- agent and OAuth refresh sessions after a rotation, and record bounded Standard-onboarding
-- migration notices.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS standard_onboarding_notice_sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agent_api_key_recovery_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_api_key_recovery_active
  ON agent_api_key_recovery_tokens(agent_id, expires_at)
  WHERE used_at IS NULL;

ALTER TABLE agent_api_key_recovery_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON agent_api_key_recovery_tokens;
CREATE POLICY "service_role_all" ON agent_api_key_recovery_tokens
  TO service_role USING (true) WITH CHECK (true);

-- The raw recovery token and raw replacement API key never enter Postgres.
-- The application hashes both before this atomic, one-shot operation.
CREATE OR REPLACE FUNCTION consume_agent_api_key_recovery(
  p_token_hash TEXT,
  p_new_api_key_hash TEXT
) RETURNS TABLE (
  agent_id UUID,
  agent_slug TEXT,
  auth_version INTEGER
) AS $$
DECLARE
  v_token agent_api_key_recovery_tokens%ROWTYPE;
  v_agent agents%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid recovery token hash';
  END IF;
  IF p_new_api_key_hash IS NULL OR length(p_new_api_key_hash) < 20 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid API key hash';
  END IF;

  SELECT * INTO v_token
    FROM agent_api_key_recovery_tokens
   WHERE token_hash = p_token_hash
     AND used_at IS NULL
     AND expires_at > NOW()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_agent FROM agents WHERE id = v_token.agent_id FOR UPDATE;
  IF NOT FOUND OR v_agent.is_active IS DISTINCT FROM TRUE THEN
    RETURN;
  END IF;

  UPDATE agents
     SET api_key_hash = p_new_api_key_hash,
         auth_version = agents.auth_version + 1
   WHERE id = v_agent.id;

  -- OAuth refresh tokens are separate opaque credentials and do not carry
  -- agents.auth_version. Remove them in this same transaction so a third
  -- party authorized with the lost API key cannot mint fresh OAuth access
  -- tokens after recovery. Already-issued OAuth access JWTs are stateless and
  -- may remain valid until their one-hour expiry.
  IF to_regclass('public.oauth_refresh_tokens') IS NOT NULL THEN
    DELETE FROM oauth_refresh_tokens
     WHERE oauth_refresh_tokens.agent_id = v_agent.id;
  END IF;
  IF to_regclass('public.oauth_auth_codes') IS NOT NULL THEN
    DELETE FROM oauth_auth_codes
     WHERE oauth_auth_codes.agent_id = v_agent.id;
  END IF;

  -- Consuming one valid link invalidates every outstanding link for the same
  -- agent. A concurrent consumer loses the token-row lock race and returns
  -- no rows; it can never overwrite the first replacement key.
  UPDATE agent_api_key_recovery_tokens
     SET used_at = NOW()
   WHERE agent_api_key_recovery_tokens.agent_id = v_agent.id
     AND used_at IS NULL;

  RETURN QUERY
  SELECT a.id, a.agent_id, a.auth_version FROM agents a WHERE a.id = v_agent.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION consume_agent_api_key_recovery(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_agent_api_key_recovery(TEXT, TEXT)
  TO service_role;
