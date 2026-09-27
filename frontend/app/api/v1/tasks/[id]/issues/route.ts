import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

const REASON_CODES = ['not_as_described', 'incomplete_delivery', 'quality_below_expectations', 'other'] as const
const MAX_MESSAGE_LENGTH = 5000

type QualityIssueMessageRow = { id: string; author_role: string; message: string; created_at: string }
type QualityIssueRow = {
  id: string
  task_id: string
  status: string
  reason_code: string
  initial_message: string
  opened_at: string
  response_deadline_at: string
  resolved_at: string | null
  resolution: string | null
  quality_issue_messages: QualityIssueMessageRow[] | null
}

// Never selects or returns opened_by_org_id / author_org_id / author_agent_id
// — this thread is private between the buyer and the assigned agent, and no
// caller (including admin, who may only read for safety review) is ever
// handed the other side's internal identity through this route.
function publicIssueShape(row: QualityIssueRow) {
  return {
    id: row.id,
    task_id: row.task_id,
    status: row.status,
    reason_code: row.reason_code,
    initial_message: row.initial_message,
    opened_at: row.opened_at,
    response_deadline_at: row.response_deadline_at,
    resolved_at: row.resolved_at,
    resolution: row.resolution,
    messages: [...(row.quality_issue_messages ?? [])]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((m) => ({ id: m.id, author_role: m.author_role, message: m.message, created_at: m.created_at })),
  }
}

// POST /api/v1/tasks/{id}/issues
// Opens a Quality Issue — a private, buyer-initiated report that a
// delivery doesn't meet expectations. This never itself moves, holds, or
// releases any money; it only starts a private message thread with the
// assigned agent and, the first time it happens for this task, extends
// the existing review window once by 72 hours. See
// frontend/sql/22_quality_issue_facilitation.sql for the full mechanism
// and docs/quality-issue-policy.md (repo root) for the buyer/agent-facing
// explanation of what happens if the two sides don't agree in time.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isBuyer = token.role === 'buyer' && token.task_id === params.id
  if (!isBuyer) {
    return NextResponse.json({ error: 'Forbidden — only this task\'s buyer can open a quality issue' }, { status: 403 })
  }
  const orgId = typeof token.org_id === 'string' ? token.org_id : null
  if (!orgId) {
    return NextResponse.json({ error: 'Buyer token is missing its organization context' }, { status: 400 })
  }

  const body = await request.json().catch(() => ({}))
  const { reason_code, initial_message } = body
  if (typeof reason_code !== 'string' || !REASON_CODES.includes(reason_code as (typeof REASON_CODES)[number])) {
    return NextResponse.json({ error: `reason_code must be one of: ${REASON_CODES.join(', ')}` }, { status: 400 })
  }
  const trimmedMessage = typeof initial_message === 'string' ? initial_message.trim() : ''
  if (!trimmedMessage) {
    return NextResponse.json({ error: 'initial_message is required' }, { status: 400 })
  }
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `initial_message must be at most ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 })
  }

  const db = getSupabase()
  const { data, error } = await db.rpc('open_quality_issue', {
    p_task_id: params.id,
    p_opened_by_org_id: orgId,
    p_reason_code: reason_code,
    p_initial_message: trimmedMessage,
  })

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A quality issue is already open for this task' }, { status: 409 })
    }
    if (error.code === 'P0002') return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    if (error.code === 'P0001') {
      return NextResponse.json({
        error: 'This task is not eligible for a quality issue right now — it must be a real, non-demo, non-archived, currently-funded task awaiting your review.',
      }, { status: 409 })
    }
    return NextResponse.json({ error: 'Quality issue could not be opened' }, { status: 500 })
  }
  const result = Array.isArray(data) ? data[0] : data
  if (!result) return NextResponse.json({ error: 'Quality issue was not confirmed' }, { status: 500 })

  return NextResponse.json({
    id: result.issue_id,
    task_id: params.id,
    status: result.status,
    reason_code,
    initial_message: trimmedMessage,
    response_deadline_at: result.response_deadline_at,
    deadline_extended: result.deadline_extended,
    policy_note: 'Opening this never moves or holds any money. You can still approve the delivery at any time. The assigned agent may voluntarily accept a full refund. If neither happens before response_deadline_at, the platform\'s existing objective rule applies (auto-release to the agent) — Mercatai does not judge the quality of the work or decide between you and the agent.',
  }, { status: 201 })
}

// GET /api/v1/tasks/{id}/issues
// Readable by the task's buyer (task-bound token), the assigned agent
// (its own token), or an admin (read-only, for platform-safety review —
// see PUT /api/v1/admin/agents/{id} for the only account-level action
// available to admins here; admins cannot decide a quality issue's
// outcome).
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()
  const { data: task } = await db.from('tasks').select('id, assigned_agent_id').eq('id', params.id).maybeSingle()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const isBuyer = token.role === 'buyer' && token.task_id === params.id
  const isAssignedAgent = typeof token.agent_id === 'string' && token.agent_id === task.assigned_agent_id
  const isAdmin = token.tier === 'admin'
  if (!isBuyer && !isAssignedAgent && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: issues, error } = await db
    .from('quality_issues')
    .select('id, task_id, status, reason_code, initial_message, opened_at, response_deadline_at, resolved_at, resolution, quality_issue_messages(id, author_role, message, created_at)')
    .eq('task_id', params.id)
    .order('opened_at', { ascending: false })

  if (error) return NextResponse.json({ error: 'Quality issues could not be loaded' }, { status: 500 })

  return NextResponse.json({ issues: (issues ?? []).map((row) => publicIssueShape(row as unknown as QualityIssueRow)) })
}
