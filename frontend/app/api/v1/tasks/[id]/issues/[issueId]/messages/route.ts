import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { clientIp } from '@/lib/server/rateLimit'
import { sendQualityIssueMessage } from '@/lib/server/email'
import { notifyAgentWebhook } from '@/lib/server/agentNotifications'

const MAX_MESSAGE_LENGTH = 5000

// POST /api/v1/tasks/{id}/issues/{issueId}/messages
// Appends one message to a private buyer↔agent thread via
// post_quality_issue_message(), which re-checks status='open' inside the
// same row-locked transaction as the insert — closing the gap a
// route-level "read status, then insert" would leave open against a
// concurrent resolution (buyer approval, agent refund, or auto-release).
// Never public, never in the activity feed, never sent to a third-party
// webhook. Message text is stored exactly as submitted (after trimming/
// length-capping) and relies on the frontend's normal JSX rendering to
// escape it on display, the same as every other piece of user-supplied
// text this app already stores (delivery notes, bid proposals, review
// text) — HTML-entity-encoding it again at write time would double-escape
// and corrupt what buyers and agents actually see.
export async function POST(request: NextRequest, { params }: { params: { id: string; issueId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()
  const { data: issue } = await db
    .from('quality_issues')
    .select('id, task_id, status, opened_by_org_id, assigned_agent_id')
    .eq('id', params.issueId)
    .maybeSingle()
  if (!issue || issue.task_id !== params.id) {
    return NextResponse.json({ error: 'Quality issue not found' }, { status: 404 })
  }

  const isBuyer = token.role === 'buyer' && token.task_id === params.id
  const isAssignedAgent = typeof token.agent_id === 'string' && token.agent_id === issue.assigned_agent_id
  if (!isBuyer && !isAssignedAgent) {
    return NextResponse.json({ error: 'Forbidden — only this task\'s buyer or the assigned agent can post here' }, { status: 403 })
  }

  const actorKey = isBuyer ? `org:${issue.opened_by_org_id}` : `agent:${issue.assigned_agent_id}`

  const body = await request.json().catch(() => ({}))
  const trimmed = typeof body.message === 'string' ? body.message.trim() : ''
  if (!trimmed) return NextResponse.json({ error: 'message is required' }, { status: 400 })
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 })
  }

  const authorRole = isBuyer ? 'buyer' : 'agent'
  const { data: postedData, error } = await db.rpc('post_quality_issue_message', {
    p_issue_id: issue.id,
    p_author_role: authorRole,
    p_author_org_id: authorRole === 'buyer' ? issue.opened_by_org_id : null,
    p_author_agent_id: authorRole === 'agent' ? issue.assigned_agent_id : null,
    p_message: trimmed,
    p_actor_key: actorKey,
    p_ip_address: clientIp(request) ?? '',
  })
  if (error) {
    if (error.code === 'P0002') return NextResponse.json({ error: 'Quality issue not found' }, { status: 404 })
    if (error.code === 'P0001') return NextResponse.json({ error: 'This quality issue is already resolved and no longer accepting messages' }, { status: 409 })
    if (error.code === 'P0003') return NextResponse.json({ error: 'Too many messages — try again later' }, { status: 429 })
    if (error.code === '42501') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json({ error: 'Message could not be saved' }, { status: 500 })
  }
  const posted = Array.isArray(postedData) ? postedData[0] : postedData
  if (!posted) return NextResponse.json({ error: 'Message was not confirmed' }, { status: 500 })

  // Best-effort: let the OTHER party know a message is waiting, so they
  // aren't stuck polling GET /issues to find out. Never blocks the
  // response, and never fails it — a lost notification email is not a
  // reason to fail a message that was already durably saved above.
  await notifyOtherParty(db, issue, authorRole).catch(() => {})

  return NextResponse.json({ id: posted.message_id, author_role: authorRole, message: trimmed, created_at: posted.created_at }, { status: 201 })
}

async function notifyOtherParty(
  db: ReturnType<typeof getSupabase>,
  issue: { id: string; task_id: string; assigned_agent_id: string },
  authorRole: 'buyer' | 'agent',
) {
  const { data: task } = await db.from('tasks').select('title, buyer_email').eq('id', issue.task_id).maybeSingle()
  if (!task) return
  if (authorRole === 'buyer') {
    const { data: agent } = await db.from('agents').select('owner_email').eq('id', issue.assigned_agent_id).maybeSingle()
    await Promise.allSettled([
      ...(agent?.owner_email
        ? [sendQualityIssueMessage({ to: agent.owner_email, taskTitle: task.title, taskId: issue.task_id, recipientRole: 'agent' })]
        : []),
      notifyAgentWebhook(db, issue.assigned_agent_id, 'quality_issue.message', {
        task_id: issue.task_id,
        quality_issue_id: issue.id,
      }),
    ])
  } else if (task.buyer_email) {
    await sendQualityIssueMessage({ to: task.buyer_email, taskTitle: task.title, taskId: issue.task_id, recipientRole: 'buyer' })
  }
}
