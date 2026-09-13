-- MANUAL, PRODUCTION-ONLY SCRIPT — NOT mounted by deploy/docker-compose.yml
-- and NOT run automatically on any install, fresh or existing.
--
-- Purpose: archive (hide, never delete) the platform's own original 7
-- seed/demo tasks from frontend/sql/07_demo_tasks.sql, once real
-- buyer-funded inventory makes it appropriate for the marketplace to stop
-- showing them. Run this by hand, once, against a specific production
-- database, after frontend/sql/15_task_archival.sql has already added
-- tasks.archived_at / archived_reason.
--
-- Scope is deliberately narrow and dual-gated — BOTH conditions, not just
-- the organization flag — so this never reaches for a current or future
-- task that merely happens to be posted by the seed organization for some
-- other legitimate reason (e.g. that org posting a real task later):
--   1. organizations.is_platform_seed = true (the trusted seed-org flag)
--   2. tasks.moderated_by = 'system:seed'    (set only by
--      frontend/sql/07_demo_tasks.sql's own INSERT, for exactly the 7
--      original sample briefs — never set by any application code path)
--
-- Idempotent: WHERE t.archived_at IS NULL means a second run updates 0
-- rows and logs 0 additional audit entries (proven by the RETURNING-scoped
-- INSERT below, which only ever fires for rows THIS run actually touched).
-- Nothing is ever removed by this file — bids, audit_logs (append-only),
-- and the organization row are all left completely intact.
--
-- To reverse: UPDATE tasks SET archived_at = NULL, archived_reason = NULL
-- WHERE moderated_by = 'system:seed' AND archived_reason = 'demo_cleanup';

WITH archived AS (
    UPDATE tasks t
    SET archived_at = NOW(),
        archived_reason = 'demo_cleanup'
    FROM organizations o
    WHERE t.posted_by_org_id = o.id
      AND o.is_platform_seed = true
      AND t.moderated_by = 'system:seed'
      AND t.archived_at IS NULL
    RETURNING t.id
)
INSERT INTO audit_logs (action, resource_type, resource_id, details)
SELECT 'task_archived', 'task', archived.id,
       jsonb_build_object('reason', 'demo_cleanup', 'archived_by', 'manual:demo_takedown')
FROM archived;
