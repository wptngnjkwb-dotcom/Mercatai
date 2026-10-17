import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { fetchAgentVisibilityRow, isAgentVisibleTo, withPrivateCacheHeaders } from '@/lib/server/agentVisibility'
import { attachPublicTaskFields } from '@/lib/server/publicTaskFields'
import { callerAgentIdFromToken, computeExecutionDecision, fetchAgentBidTaskIds } from '@/lib/server/executionAuthorization'
import { taskAcceptsNewBids } from '@/lib/server/biddingWindow'

// Public "work history" for an agent's profile — same public/no-auth shape
// as GET /agents/[id]/reputation. Keep both the projection and the
// moderation filter explicit: this must never leak buyer_email, delivery
// notes, disputes, embeddings, or a quarantined/pending/rejected task, no
// matter what the tasks table grows in the future. posted_by_org_id is
// selected only to derive is_demo below (see attachPublicTaskFields) — it
// must never itself appear in the returned JSON.
const PUBLIC_TASK_COLUMNS = 'id,title,description,category,required_capabilities,required_languages,budget_min_eur,budget_max_eur,deadline_hours,status,assigned_agent_id,bidding_closes_at,created_at,assigned_at,delivery_deadline_at,posted_by_org_id,archived_at,visibility,source,stripe_account_requirement'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const token = await getTokenFromRequest(request)

  // `me` is a private, authenticated convenience alias. Several agent
  // clients naturally use /agents/me/tasks; passing that literal through to
  // PostgREST's UUID filter used to raise `invalid input syntax for type uuid`
  // and turn a harmless request into a production 500/Sentry event.
  // Resolve it only from a verified access-token claim, never from a query
  // parameter or agent-supplied body value.
  const requestedId = params.id
  let agent: { id: string; profile_visibility?: string | null } | null = null
  let effectiveToken = token

  if (requestedId === 'me') {
    if (!token || typeof token.agent_id !== 'string') {
      return withPrivateCacheHeaders(NextResponse.json(
        { error: 'Unauthorized — /agents/me/tasks requires an agent access token' },
        { status: 401 }
      ))
    }
    if (token.role === 'oauth' && (!Array.isArray(token.scopes) || !token.scopes.includes('tasks:read'))) {
      return withPrivateCacheHeaders(NextResponse.json(
        { error: 'Forbidden — OAuth token requires tasks:read scope' },
        { status: 403 }
      ))
    }

    // First-party agent tokens carry the database UUID in agent_id. OAuth
    // access tokens intentionally carry the stable public slug there and
    // the UUID in agent_uuid. Never pass the slug into a UUID filter (the
    // old behavior produced a Postgres 22P02 and a production 500).
    const tokenAgentUuid = token.role === 'oauth' && typeof token.agent_uuid === 'string'
      ? token.agent_uuid
      : token.agent_id
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenAgentUuid)
    if (isUuid) {
      agent = await fetchAgentVisibilityRow(db, tokenAgentUuid)
    } else {
      const { data, error } = await db
        .from('agents')
        .select('id, profile_visibility')
        .eq('agent_id', token.agent_id)
        .single()
      if (error && (error as { code?: string }).code !== 'PGRST116') throw error
      agent = data
    }
    if (agent) effectiveToken = { ...token, agent_id: agent.id }
  } else {
    // Public profile routes accept either the database UUID or the stable
    // human-readable agent_id. Resolving the latter here also ensures that
    // arbitrary strings never reach a UUID comparison in Postgres.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedId)
    if (isUuid) {
      agent = await fetchAgentVisibilityRow(db, requestedId)
    } else {
      const { data, error } = await db
        .from('agents')
        .select('id, profile_visibility')
        .eq('agent_id', requestedId)
        .single()
      if (error && (error as { code?: string }).code !== 'PGRST116') throw error
      agent = data
    }
  }

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  if (!isAgentVisibleTo(effectiveToken, agent)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const canSeePrivateHistory = effectiveToken?.tier === 'admin'
    || (typeof effectiveToken?.agent_id === 'string' && effectiveToken.agent_id === agent.id)
  let taskQuery = db
    .from('tasks')
    .select(PUBLIC_TASK_COLUMNS)
    .eq('assigned_agent_id', agent.id)
    .eq('moderation_status', 'approved')
    .is('archived_at', null)
  if (!canSeePrivateHistory) taskQuery = taskQuery.eq('visibility', 'public')
  const { data, error } = await taskQuery.order('created_at', { ascending: false }).limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rawRows = data ?? []

  try {
    const callerAgentId = callerAgentIdFromToken(effectiveToken)
    // One batched query for the whole page (never one per task) — see
    // fetchAgentBidTaskIds's own doc comment. In practice this is always
    // empty here (every row is already assigned, never 'open'/'bidding'),
    // but computing it the same batched way keeps this endpoint's decision
    // identical in shape to GET /tasks and GET /tasks/[id].
    const [decorated, bidTaskIds] = await Promise.all([
      attachPublicTaskFields(db, rawRows, effectiveToken),
      fetchAgentBidTaskIds(db, callerAgentId, rawRows.map((t: any) => t.id)),
    ])

    // Built field-by-field, not returned as-is — same defense-in-depth as
    // GET /tasks/[id] and GET /agents/[id]: the safe column list above is
    // the first guard, this is the second, so a future column added to
    // PUBLIC_TASK_COLUMNS by mistake still can't reach the response.
    const tasks = decorated.map((t, i) => {
      const raw = rawRows[i] as any
      const biddingOpen = taskAcceptsNewBids(raw)
      const decision = computeExecutionDecision({
        isDemo: t.is_demo,
        status: raw.status,
        fundingStatus: t.funding_status,
        callerAgentId,
        assignedAgentId: raw.assigned_agent_id ?? null,
        hasExistingBid: bidTaskIds.has(raw.id),
        biddingOpen,
      })
      return {
        id: raw.id,
        title: raw.title,
        description: raw.description,
        category: raw.category,
        required_capabilities: Array.isArray(raw.required_capabilities) ? raw.required_capabilities : [],
        required_languages: Array.isArray(raw.required_languages) ? raw.required_languages : [],
        budget_min_eur: raw.budget_min_eur,
        budget_max_eur: raw.budget_max_eur,
        deadline_hours: raw.deadline_hours,
        status: raw.status,
        bidding_closes_at: raw.bidding_closes_at,
        bidding_open: biddingOpen,
        // Every row here is already filtered to assigned_agent_id ===
        // agent.id, and the caller already passed isAgentVisibleTo for
        // that same agent above — so this is never a new disclosure.
        assigned_agent_id: t.assigned_agent_id,
        created_at: raw.created_at,
        assigned_at: raw.assigned_at,
        delivery_deadline_at: raw.delivery_deadline_at,
        is_demo: t.is_demo,
        funding_status: t.funding_status,
        execution_authorized: decision.execution_authorized,
        next_action: decision.next_action,
        visibility: raw.visibility,
        source: raw.source,
        stripe_account_requirement: raw.stripe_account_requirement,
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
