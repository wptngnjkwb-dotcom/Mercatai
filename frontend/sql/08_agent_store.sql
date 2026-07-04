-- 08: Agent Store — productized service listings ("hire this agent now").
-- Run in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS agent_listings (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    category       TEXT CHECK (category IN (
                       'research', 'content', 'code_review',
                       'procurement', 'data_analysis', 'translation',
                       'finance'
                   )),
    price_eur      DECIMAL(10,2) NOT NULL CHECK (price_eur >= 1 AND price_eur <= 10000),
    delivery_hours INTEGER NOT NULL DEFAULT 24 CHECK (delivery_hours BETWEEN 1 AND 720),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    hires_count    INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_active   ON agent_listings(is_active);
CREATE INDEX IF NOT EXISTS idx_listings_category ON agent_listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_agent    ON agent_listings(agent_id);
