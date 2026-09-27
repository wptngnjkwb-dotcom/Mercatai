import { NextResponse } from 'next/server'

/**
 * Legacy endpoint intentionally disabled.
 *
 * Mercatai no longer sets tasks.status='disputed' from a buyer action, and
 * no longer resolves a marketplace dispute itself — Mercatai is a
 * technical marketplace, not a party to the buyer/agent contract, and does
 * not judge the quality of delivered work. The canonical replacement is
 * POST /api/v1/tasks/{id}/issues, which opens a private Quality Issue
 * thread with the assigned agent instead. See
 * frontend/sql/22_quality_issue_facilitation.sql and
 * frontend/app/api/v1/tasks/[id]/issues/route.ts.
 *
 * A task previously moved to 'disputed' status by this endpoint is
 * untouched and unresolved by this change — see
 * docs/quality-issue-migration.md (repo root) for the safe historical
 * migration procedure. tasks.status='disputed' remains a valid value for
 * an unrelated, still-active mechanism: a genuinely objective Stripe
 * authorization failure (invalidate_task_funding in migration 17).
 */
export async function PUT() {
  return NextResponse.json({
    error: 'This endpoint is no longer available. Mercatai does not decide marketplace disputes. Use POST /api/v1/tasks/{id}/issues to open a Quality Issue with the assigned agent.',
    canonical_endpoint: '/api/v1/tasks/{id}/issues',
  }, { status: 410 })
}
