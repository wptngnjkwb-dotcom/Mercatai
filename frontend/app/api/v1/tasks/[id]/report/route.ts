import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest, describeAuthFailure } from '@/lib/server/auth'
import { recordModerationEvent } from '@/lib/server/taskModeration/audit'
import { PUBLIC_EXPLANATIONS } from '@/lib/server/taskModeration/policy'
import type { ModerationReason } from '@/lib/server/taskModeration/types'
import { sendModerationAlert } from '@/lib/server/email'

const VALID_REASON_CODES = new Set(Object.keys(PUBLIC_EXPLANATIONS))

// Distinct *trusted* reporters behind a task's reports before it's pulled
// from public view pending admin review — not a raw report count, and not
// just distinct owner orgs. Both agent registration AND organization
// creation are instant, free, and self-service (an org is auto-created
// per agent registration whenever the owner_email doesn't match an
// existing one), so distinct-org alone still lets one person, within the
// existing per-IP registration rate limit, spin up 3 agents under 3 fresh
// orgs with 3 distinct throwaway emails and silently hide any competitor's
// task. A reporter only counts toward this automatic threshold once it has
// some track record — see isTrustedReporter below. Untrusted reports are
// still persisted and still always notify an admin (see sendModerationAlert
// below); they just don't auto-hide anything on their own. Still a
// placeholder policy knob — tune once there's real report volume to
// calibrate against.
const REPORT_QUARANTINE_THRESHOLD = 3
const TRUSTED_REPORTER_MIN_AGE_DAYS = 7

function isTrustedReporter(agent: { is_active?: boolean; registered_at?: string | null; total_tasks_completed?: number | null }): boolean {
  if (!agent.is_active) return false
  const oldEnough = !!agent.registered_at && Date.now() - new Date(agent.registered_at).getTime() >= TRUSTED_REPORTER_MIN_AGE_DAYS * 24 * 60 * 60 * 1000
  const hasTrackRecord = (agent.total_tasks_completed ?? 0) > 0
  return oldEnough || hasTrackRecord
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) {
      const code = await describeAuthFailure(request)
      const error =
        code === 'token_expired' ? 'Access token expired — POST /api/v1/auth/refresh or log in again (tokens last 15 minutes)'
        : code === 'missing_token' ? 'Unauthorized — missing Bearer token'
        : 'Unauthorized — invalid token'
      return NextResponse.json({ error, code }, { status: 401 })
    }

    // Reporting is an agent action — buyers already have /dispute for their
    // own tasks, and admins act directly through the moderation queue.
    const tokenAgentId = typeof token.agent_id === 'string' && token.agent_id ? token.agent_id : null
    if (!tokenAgentId) {
      return NextResponse.json({ error: 'Forbidden — only an agent token can report a task' }, { status: 403 })
    }

    const db = getSupabase()

    const { data: reportingAgent } = await db.from('agents').select('is_active').eq('id', tokenAgentId).maybeSingle()
    if (!reportingAgent || !reportingAgent.is_active) {
      return NextResponse.json({ error: 'Forbidden — this agent is not active' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { reason_code, details } = body
    if (!reason_code || typeof reason_code !== 'string' || !VALID_REASON_CODES.has(reason_code)) {
      return NextResponse.json({ error: `reason_code is required and must be one of: ${Array.from(VALID_REASON_CODES).join(', ')}` }, { status: 400 })
    }
    if (details && (typeof details !== 'string' || details.length > 1000)) {
      return NextResponse.json({ error: 'details must be a string of at most 1000 characters' }, { status: 400 })
    }

    const { data: task } = await db.from('tasks').select('id, moderation_status').eq('id', params.id).single()
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    const { error: insertError } = await db
      .from('task_reports')
      .insert({ task_id: task.id, reporter_agent_id: tokenAgentId, reason_code, details: details || null })

    if (insertError) {
      // Unique violation on (task_id, reporter_agent_id) — one report per agent per task
      if ((insertError as any).code === '23505') {
        return NextResponse.json({ error: 'You have already reported this task' }, { status: 409 })
      }
      throw insertError
    }

    await recordModerationEvent({
      taskId: task.id,
      eventType: 'reported',
      actorType: 'agent',
      actorId: tokenAgentId,
      reasonCodes: [reason_code as ModerationReason],
      notes: details || undefined,
    })

    const { data: reportRows } = await db
      .from('task_reports')
      .select('reporter_agent_id')
      .eq('task_id', task.id)
    const reporterAgentIds = Array.from(new Set((reportRows ?? []).map((r: any) => r.reporter_agent_id).filter(Boolean)))

    let distinctTrustedOrgCount = 0
    if (reporterAgentIds.length > 0) {
      const { data: reporterAgents } = await db
        .from('agents')
        .select('id, owner_org_id, is_active, registered_at, total_tasks_completed')
        .in('id', reporterAgentIds)
      const trustedOrgIds = (reporterAgents ?? [])
        .filter((a: any) => isTrustedReporter(a))
        .map((a: any) => a.owner_org_id)
        .filter(Boolean)
      distinctTrustedOrgCount = new Set(trustedOrgIds).size
    }

    // Only downgrade a task that's currently public — a task already
    // quarantined/rejected/pending stays exactly as it is, so this can
    // never move a decision backwards toward being more visible.
    let autoQuarantined = false
    if (distinctTrustedOrgCount >= REPORT_QUARANTINE_THRESHOLD && task.moderation_status === 'approved') {
      await db
        .from('tasks')
        .update({ moderation_status: 'quarantined', moderated_at: new Date().toISOString(), moderated_by: 'system:report_threshold' })
        .eq('id', task.id)

      await recordModerationEvent({
        taskId: task.id,
        eventType: 'report_threshold_quarantine',
        actorType: 'system',
        notes: `Auto-quarantined after reports from ${distinctTrustedOrgCount} distinct trusted-reporter organizations reached the review threshold (${REPORT_QUARANTINE_THRESHOLD}).`,
      })

      autoQuarantined = true
    }

    // Every report notifies an admin, not just the ones that cross the
    // automatic threshold — see sendModerationAlert's own comment.
    sendModerationAlert({
      taskId: task.id,
      reportCount: reporterAgentIds.length,
      reasonCode: reason_code,
      autoQuarantined,
    }).catch(console.error)

    return NextResponse.json({ received: true, auto_quarantined: autoQuarantined }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 })
  }
}
