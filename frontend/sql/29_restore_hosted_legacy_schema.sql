-- Migration 29: restore the legacy hosted schema that predates the numbered
-- migration chain.
--
-- The table shapes, constraints, indexes and RPC behaviour below were
-- recovered read-only from the production catalog on 2026-10-23. Production
-- already contains these objects, so this migration is intentionally
-- idempotent there. Its primary purpose is to make a fresh/self-hosted install
-- match the schema the application has always used.

CREATE TABLE IF NOT EXISTS api_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  owner_org_id UUID REFERENCES organizations(id),
  scopes TEXT[] DEFAULT ARRAY['tasks:read', 'agents:read']::TEXT[],
  rate_limit_per_hour INTEGER DEFAULT 1000,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  plan TEXT NOT NULL DEFAULT 'free'
    CONSTRAINT api_clients_plan_check CHECK (plan = ANY (ARRAY['free', 'starter', 'pro']::TEXT[])),
  stripe_subscription_id TEXT
);

CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  year_month TEXT NOT NULL,
  call_count BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT api_usage_client_id_year_month_key UNIQUE (client_id, year_month)
);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_client_id TEXT NOT NULL CONSTRAINT oauth_apps_oauth_client_id_key UNIQUE,
  client_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  redirect_uris TEXT[] NOT NULL,
  allowed_scopes TEXT[] DEFAULT ARRAY[
    'tasks:read', 'agents:read', 'profile:read', 'bids:write'
  ]::TEXT[],
  owner_api_client_id UUID REFERENCES api_clients(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code TEXT PRIMARY KEY,
  oauth_app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL CONSTRAINT oauth_refresh_tokens_token_hash_key UNIQUE,
  oauth_app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES api_clients(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_fired_at TIMESTAMPTZ,
  failure_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  response_status INTEGER,
  success BOOLEAN,
  delivered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS affiliate_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  platform_fee_eur NUMERIC NOT NULL,
  affiliate_amount_eur NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  content TEXT,
  is_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID CONSTRAINT reviews_task_id_key UNIQUE REFERENCES tasks(id),
  agent_id UUID REFERENCES agents(id),
  buyer_org_id UUID,
  rating INTEGER CONSTRAINT reviews_rating_check CHECK (rating >= 1 AND rating <= 5),
  text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_usage_client_month_idx
  ON api_usage(client_id, year_month);
CREATE INDEX IF NOT EXISTS affiliate_earnings_client_idx
  ON affiliate_earnings(client_id);
CREATE INDEX IF NOT EXISTS affiliate_earnings_task_idx
  ON affiliate_earnings(task_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_agent
  ON agent_portfolio(agent_id);
CREATE INDEX IF NOT EXISTS idx_reviews_agent
  ON reviews(agent_id);

ALTER TABLE api_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- The application reaches these private tables exclusively through its
-- service-role client. No direct anon/authenticated policy exists in the
-- hosted database, so keep fresh installs fail-closed as well.
REVOKE ALL ON TABLE api_clients, api_usage, oauth_apps, oauth_auth_codes,
  oauth_refresh_tokens, webhooks, webhook_deliveries, affiliate_earnings,
  agent_portfolio, reviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE api_clients, api_usage, oauth_apps, oauth_auth_codes,
  oauth_refresh_tokens, webhooks, webhook_deliveries, affiliate_earnings,
  agent_portfolio, reviews TO service_role;

CREATE OR REPLACE FUNCTION increment_api_usage(
  p_client_id UUID,
  p_year_month TEXT
) RETURNS BIGINT AS $$
  INSERT INTO api_usage (client_id, year_month, call_count)
  VALUES (p_client_id, p_year_month, 1)
  ON CONFLICT (client_id, year_month)
  DO UPDATE SET call_count = api_usage.call_count + 1
  RETURNING call_count;
$$ LANGUAGE sql SET search_path = public;

CREATE OR REPLACE FUNCTION increment_webhook_failures(
  webhook_id UUID
) RETURNS VOID AS $$
  UPDATE webhooks
     SET failure_count = failure_count + 1
   WHERE id = webhook_id;
$$ LANGUAGE sql SET search_path = public;

REVOKE ALL ON FUNCTION increment_api_usage(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_api_usage(UUID, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION increment_webhook_failures(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_webhook_failures(UUID)
  TO service_role;
