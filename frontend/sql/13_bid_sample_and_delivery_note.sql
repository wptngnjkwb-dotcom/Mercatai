-- 13: bids.sample_preview and tasks.delivery_note.
--
-- Both columns were already live in production — added ad hoc, outside any
-- tracked migration — before this file existed. The app has always read and
-- written them (POST /api/v1/bids and OpenAPI for sample_preview; POST
-- /api/v1/tasks/{id}/deliver for delivery_note), so any self-hosted install
-- built purely from backend/db/schema.sql + frontend/sql/*.sql was missing
-- both: bidding and delivery failed outright with a PostgREST "column not
-- found in schema cache" error, confirmed during a full local Stripe
-- test-mode verification pass (see docs/self-hosting.md for how to run one
-- against a fresh local instance).
--
-- Not a new feature and not a behavior change for production, which has
-- carried these columns all along — this only brings self-hosted installs,
-- and the canonical schema, up to what the app has always required.

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS sample_preview TEXT;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS delivery_note TEXT;
