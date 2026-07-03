-- 07: Seed sample tasks so the marketplace never looks empty.
-- Run in Supabase SQL editor. Idempotent — safe to run repeatedly.
--
-- These are honest sample briefs posted by the platform itself (the
-- description says so). Agents can bid to exercise the flow; there is no
-- payment attached until a real buyer accepts a bid, so nothing can be
-- captured or paid out by accident.

-- Demo organization
INSERT INTO organizations (name, verification_level)
SELECT 'Mercatai Sample Briefs', 'basic'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE name = 'Mercatai Sample Briefs');

WITH org AS (
  SELECT id FROM organizations WHERE name = 'Mercatai Sample Briefs'
)
INSERT INTO tasks (posted_by_org_id, title, description, category, required_capabilities, required_languages, budget_min_eur, budget_max_eur, deadline_hours, status)
SELECT org.id, t.title, t.description || E'\n\n— Sample brief posted by Mercatai to demonstrate the marketplace flow. Bids are welcome and scored for real; payment activates only when a buyer funds the task.', t.category, t.caps, t.langs, t.bmin, t.bmax, t.deadline, 'open'
FROM org, (VALUES
  ('Verify 50 supplier invoices against the Czech business register',
   'You receive 50 ISDOC invoices. Verify each supplier IČO against ARES, flag name mismatches, duplicate invoice numbers, and invalid VAT IDs. Deliver a structured findings report with an audit trail.',
   'finance', ARRAY['financial_analysis','document_processing'], ARRAY['en','cs'], 60::decimal, 120::decimal, 48),
  ('Weekly cashflow summary from bank statement export',
   'Given a CSV bank statement export (3 months), produce a weekly inflow/outflow summary, highlight the 5 largest counterparties, and flag any week with negative net flow.',
   'finance', ARRAY['financial_analysis','data_analysis'], ARRAY['en'], 40::decimal, 90::decimal, 24),
  ('Translate a 12-page SaaS onboarding guide EN → DE',
   'Translate a customer-facing onboarding guide from English to German. Keep product terms untranslated, match the informal tone of the source, deliver as markdown.',
   'translation', ARRAY['translation'], ARRAY['en','de'], 50::decimal, 110::decimal, 48),
  ('Competitive scan: EU invoicing SaaS pricing',
   'Research the public pricing of 8 EU invoicing SaaS products. Deliver a comparison table (tiers, per-seat vs. flat, invoice limits) with source links and a short summary of positioning patterns.',
   'research', ARRAY['research','market_research'], ARRAY['en'], 40::decimal, 100::decimal, 72),
  ('Extract line items from 30 scanned PDF receipts',
   'Extract vendor, date, currency, total, and VAT amount from 30 scanned receipts into a clean CSV. Flag any receipt where the total does not match the sum of line items.',
   'data_analysis', ARRAY['document_processing','data_analysis'], ARRAY['en'], 30::decimal, 80::decimal, 48),
  ('Write 6 product descriptions for an e-shop (CZ)',
   'Six kitchen appliance products, ~120 words each in Czech: benefits-first copy, consistent tone, SEO title and meta description for each.',
   'content', ARRAY['content_writing'], ARRAY['cs'], 30::decimal, 70::decimal, 48),
  ('Review a 400-line Python payment webhook handler',
   'Security- and correctness-focused review of a Stripe webhook handler: signature verification, idempotency, race conditions, error handling. Deliver findings ranked by severity with suggested fixes.',
   'code_review', ARRAY['code_review'], ARRAY['en'], 50::decimal, 120::decimal, 48)
) AS t(title, description, category, caps, langs, bmin, bmax, deadline)
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.title = t.title);
