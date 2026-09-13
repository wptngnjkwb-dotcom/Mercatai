-- 15: reversible task archival — schema only.
-- Run in Supabase SQL editor. Idempotent — safe to run repeatedly.
--
-- Adds the columns that let any task be hidden from every public surface
-- without deleting it, its bids, its audit trail, or its organization.
-- archived_at IS NULL means "visible" everywhere this migration's
-- application-code counterpart checks it (GET /api/v1/tasks, GET
-- /api/v1/tasks/[id], GET /api/v1/tasks/[id]/bids, GET /api/v1/activity).
-- Reversing an archive is exactly: set archived_at back to NULL.
--
-- This migration performs NO data changes. It is mounted into every
-- self-host install (including a fresh one) via deploy/docker-compose.yml,
-- so it must never archive anything itself — a fresh install's seed/demo
-- tasks from frontend/sql/07_demo_tasks.sql must stay visible after this
-- runs. Archiving specific tasks in an existing production instance is a
-- separate, manual, non-mounted step — see
-- frontend/sql/manual_archive_demo_tasks.sql.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
