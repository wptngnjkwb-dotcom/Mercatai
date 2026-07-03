-- 06: Admin back-office — platform settings (key/value).
-- Run in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS platform_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default platform fee (percent of gross, on top of ~0.8% Stripe fee)
INSERT INTO platform_settings (key, value)
VALUES ('platform_fee_percent', '4.2')
ON CONFLICT (key) DO NOTHING;
