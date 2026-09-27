import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { isRateLimited, clientIp } from '@/lib/server/rateLimit'
import { auditLog } from '@/lib/server/audit'

const MAX_MESSAGE_LENGTH = 5000

// POST /api/v1/tasks/{id}/issues/{issueId}/messages
// Appends one message to a private buyer↔agent thread. Never public, never
// in the activity feed, never sent to a third-party webhook — see
// frontend/sql/22_quality_issue_facilitation.sql. Message text is stored
// exactly as submitted (after trimming/length-capping) and relies on the
// frontend's normal JSX rendering to escape it on display, the same as
// every other piece of user-supplied text this app already stores
// (delivery notes, bid proposals, review text) — HTML-entity-encoding it
// again at write time would double-escape and corrupt what buyers and
// agents actually see.
export async function POST(request: NextRequest, { params }: { params: { id: string; issueId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ip = clientIp(request)
  if (await isRateLimited({ action: 'quality_issue_message', ip, windowMinutes: 60, maxEvents: 60 })) {
    return NextResponse.json({ error: 'Too many messages — try again later' }, { status: 429 })
  }

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
  if (issue.status !== 'open') {
    return NextResponse.json({ error: 'This quality issue is already resolved and no longer accepting messages' }, { status: 409 })
  }

  const body = await request.json().catch(() => ({}))
  const trimmed = typeof body.message === 'string' ? body.message.trim() : ''
  if (!trimmed) return NextResponse.json({ error: 'message is required' }, { status: 400 })
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 })
  }

  const authorRole = isBuyer ? 'buyer' : 'agent'
  const { data: inserted, error } = await db
    .from('quality_issue_messages')
    .insert({
      quality_issue_id: issue.id,
      author_role: authorRole,
      ...(authorRole === 'buyer' ? { author_org_id: issue.opened_by_org_id } : { author_agent_id: issue.assigned_agent_id }),
      message: trimmed,
    })
    .select('id, author_role, message, created_at')
    .single()

  if (error || !inserted) return NextResponse.json({ error: 'Message could not be saved' }, { status: 500 })

  // Counted by the rate limiter above and left as a safety audit trail —
  // deliberately never the message text or the other side's org/agent id.
  await auditLog({
    action: 'quality_issue_message',
    resource_type: 'quality_issue',
    resource_id: issue.id,
    details: { author_role: authorRole },
    ip_address: ip ?? undefined,
  })

  return NextResponse.json(inserted, { status: 201 })
}
