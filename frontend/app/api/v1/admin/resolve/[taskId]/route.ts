import { NextResponse } from 'next/server'

/**
 * Legacy endpoint intentionally disabled.
 *
 * Mercatai does not decide a marketplace dispute — it never chooses
 * between refunding the buyer and paying the agent. That judgment
 * belonged to the two parties to the underlying contract, not to the
 * platform. The replacement is the Quality Issue flow: the buyer can
 * always approve (PUT /api/v1/tasks/{id}/approve), the agent can
 * voluntarily accept a full refund
 * (POST /api/v1/tasks/{id}/issues/{issueId}/accept-refund), and if
 * neither happens the platform's existing, pre-disclosed objective rule
 * (auto-release once the — possibly once-extended — review deadline
 * passes) applies exactly as it always has. See
 * frontend/sql/22_quality_issue_facilitation.sql.
 *
 * An admin may still read a Quality Issue for safety review
 * (GET /api/v1/tasks/{id}/issues) and may still limit or deactivate an
 * agent's account for violating platform rules
 * (PUT /api/v1/admin/agents/{id}) — neither of those decides a contractual
 * claim between a buyer and an agent, which is what this endpoint used to
 * do and no longer does.
 *
 * A task this endpoint previously resolved, or a task still sitting in
 * 'disputed' status because this endpoint was never called for it, is
 * untouched by this change — see
 * docs/quality-issue-migration.md (repo root) for the safe historical
 * migration procedure. Nothing here deletes or auto-resolves that data.
 */
export async function PUT() {
  return NextResponse.json({
    error: 'This endpoint is no longer available. Mercatai does not decide marketplace disputes between a buyer and an agent. See the Quality Issue flow: POST /api/v1/tasks/{id}/issues and POST /api/v1/tasks/{id}/issues/{issueId}/accept-refund.',
    canonical_endpoint: '/api/v1/tasks/{id}/issues',
  }, { status: 410 })
}
