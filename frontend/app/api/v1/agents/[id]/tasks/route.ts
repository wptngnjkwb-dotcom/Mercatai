import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { fetchAgentVisibilityRow, isAgentVisibleTo, withPrivateCacheHeaders } from '@/lib/server/agentVisibility'
import { attachPublicTaskFields } from '@/lib/server/publicTaskFields'
import { callerAgentIdFromToken, computeExecutionDecision, fetchAgentBidTaskIds } from '@/lib/server/executionAuthorization'

// Public "work history" for an agent's profile — same public/no-auth shape
// as GET /agents/[id]/reputation. Keep both the projection and the
// moderation filter explicit: this must never leak buyer_email, delivery
// notes, disputes, embeddings, or a quarantined/pending/rejected task, no
// matter what the tasks table grows in the future. posted_by_org_id is
// selected only to derive is_demo below (see attachPublicTaskFields) — it
// must never itself appear in the returned JSON.
const PUBLIC_TASK_COLUMNS = 'id,title,description,category,budget_min_eur,budget_max_eur,deadline_hours,status,assigned_agent_id,created_at,assigned_at,delivery_deadline_at,posted_by_org_id'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const agent = await fetchAgentVisibilityRow(db, params.id)
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  const token = await getTokenFromRequest(request)
  if (!isAgentVisibleTo(token, agent)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const { data, error } = await db
    .from('tasks')
    .select(PUBLIC_TASK_COLUMNS)
    .eq('assigned_agent_id', params.id)
    .eq('moderation_status', 'approved')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rawRows = data ?? []

  try {
    const callerAgentId = callerAgentIdFromToken(token)
    // One batched query for the whole page (never one per task) — see
    // fetchAgentBidTaskIds's own doc comment. In practice this is always
    // empty here (every row is already assigned, never 'open'/'bidding'),
    // but computing it the same batched way keeps this endpoint's decision
    // identical in shape to GET /tasks and GET /tasks/[id].
    const [decorated, bidTaskIds] = await Promise.all([
      attachPublicTaskFields(db, rawRows, token),
      fetchAgentBidTaskIds(db, callerAgentId, rawRows.map((t: any) => t.id)),
    ])

    // Built field-by-field, not returned as-is — same defense-in-depth as
    // GET /tasks/[id] and GET /agents/[id]: the safe column list above is
    // the first guard, this is the second, so a future column added to
    // PUBLIC_TASK_COLUMNS by mistake still can't reach the response.
    const tasks = decorated.map((t, i) => {
      const raw = rawRows[i] as any
      const decision = computeExecutionDecision({
        isDemo: t.is_demo,
        status: raw.status,
        fundingStatus: t.funding_status,
        callerAgentId,
        assignedAgentId: raw.assigned_agent_id ?? null,
        hasExistingBid: bidTaskIds.has(raw.id),
      })
      return {
        id: raw.id,
        title: raw.title,
        description: raw.description,
        category: raw.category,
        budget_min_eur: raw.budget_min_eur,
        budget_max_eur: raw.budget_max_eur,
        deadline_hours: raw.deadline_hours,
        status: raw.status,
        // Every row here is already filtered to assigned_agent_id ===
        // params.id, and the caller already passed isAgentVisibleTo for
        // that same agent above — so this is never a new disclosure.
        assigned_agent_id: t.assigned_agent_id,
        created_at: raw.created_at,
        assigned_at: raw.assigned_at,
        delivery_deadline_at: raw.delivery_deadline_at,
        is_demo: t.is_demo,
        funding_status: t.funding_status,
        execution_authorized: decision.execution_authorized,
        next_action: decision.next_action,
      }
    })
    // execution_authorized/next_action (and funding_status) can differ by
    // caller — never cacheable across callers.
    return withPrivateCacheHeaders(NextResponse.json({ tasks }))
  } catch (err: unknown) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to load agent task history' }, { status: 500 })
  }
}
