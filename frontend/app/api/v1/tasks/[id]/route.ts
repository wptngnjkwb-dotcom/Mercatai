import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { attachPublicTaskFields } from '@/lib/server/publicTaskFields'
import { getTokenFromRequest } from '@/lib/server/auth'
import { withPrivateCacheHeaders } from '@/lib/server/agentVisibility'
import { callerAgentIdFromToken, computeExecutionDecision, fetchAgentBidTaskIds } from '@/lib/server/executionAuthorization'

// This endpoint is public. Keep both the database projection and the response
// explicit so contact details, delivered work, embeddings, or future private
// columns cannot leak when the tasks table changes. posted_by_org_id is
// selected only to derive is_demo below (see attachPublicTaskFields) — it
// must never itself appear in the returned JSON, same treatment as
// moderation_status just above it.
const PUBLIC_TASK_COLUMNS = 'id,title,description,category,required_capabilities,required_languages,budget_min_eur,budget_max_eur,deadline_hours,status,assigned_agent_id,bidding_closes_at,created_at,assigned_at,delivery_deadline_at,moderation_status,posted_by_org_id,archived_at,archived_reason'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const token = await getTokenFromRequest(request)
  const isAdmin = token?.tier === 'admin'
  const { data: task, error } = await db.from('tasks').select(PUBLIC_TASK_COLUMNS).eq('id', params.id).single()
  // Trust & Safety: a quarantined/rejected/pending task doesn't exist from
  // the outside — same 404 as a missing task, so its moderation state
  // (and the fact it was ever reviewed) isn't leaked to the public. An
  // archived task (e.g. the platform's own demo tasks) gets the exact
  // same treatment for anyone but an admin — admin can still look it up
  // directly by id, see archived_at/archived_reason below, to find demo
  // or other archived data without a separate lookup surface.
  if (error || !task || task.moderation_status !== 'approved' || (task.archived_at && !isAdmin)) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // attachPublicTaskFields throws on a failed organizations/transactions
  // lookup rather than silently defaulting — fail closed with a 500 instead
  // of ever risking a demo task rendering as real, or a funding state that
  // couldn't actually be verified.
  try {
    const callerAgentId = callerAgentIdFromToken(token)
    const [[{ is_demo, funding_status, assigned_agent_id }], bidTaskIds] = await Promise.all([
      attachPublicTaskFields(db, [task], token),
      fetchAgentBidTaskIds(db, callerAgentId, [task.id]),
    ])

    // execution_authorized/next_action — see
    // frontend/lib/server/executionAuthorization.ts. Computed from
    // task.assigned_agent_id, the REAL (unmasked) column value still held
    // here, never from the `assigned_agent_id` above (already masked to
    // null for a private agent the caller isn't) — an anonymous or
    // different agent must never learn a private assigned agent's
    // identity through this field, so the decision itself never depends
    // on whether that agent is public or private, only on whether the
    // caller IS that agent.
    const decision = computeExecutionDecision({
      isDemo: is_demo,
      status: task.status,
      fundingStatus: funding_status,
      callerAgentId,
      assignedAgentId: task.assigned_agent_id ?? null,
      hasExistingBid: bidTaskIds.has(task.id),
    })

    return withPrivateCacheHeaders(NextResponse.json({
      id: task.id,
      title: task.title,
      description: task.description,
      category: task.category,
      required_capabilities: task.required_capabilities,
      required_languages: task.required_languages,
      budget_min_eur: task.budget_min_eur,
      budget_max_eur: task.budget_max_eur,
      deadline_hours: task.deadline_hours,
      status: task.status,
      // Masked to null for a private agent unless the caller is that agent,
      // an admin — the task buyer sees the chosen display identity on the
      // bid but never needs this UUID. Deliberately NOT task.assigned_agent_id.
      assigned_agent_id,
      bidding_closes_at: task.bidding_closes_at,
      created_at: task.created_at,
      assigned_at: task.assigned_at,
      delivery_deadline_at: task.delivery_deadline_at,
      is_demo,
      funding_status,
      execution_authorized: decision.execution_authorized,
      next_action: decision.next_action,
      // Only ever non-null here for an admin viewing an archived task —
      // anyone else who could see this field at all would already have
      // 404'd above.
      archived_at: task.archived_at,
      archived_reason: task.archived_reason,
    }))
  } catch (err: unknown) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to load task' }, { status: 500 })
  }
}
