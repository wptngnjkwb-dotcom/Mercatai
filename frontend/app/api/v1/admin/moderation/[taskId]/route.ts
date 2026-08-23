import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { runAutoBids } from '@/lib/server/autobid'
import { sendTaskCreated } from '@/lib/server/email'
import { signToken } from '@/lib/server/auth'
import { recordModerationEvent } from '@/lib/server/taskModeration/audit'

const ACTION_TO_STATUS = {
  approve: 'approved',
  quarantine: 'quarantined',
  reject: 'rejected',
} as const
const ACTION_TO_EVENT = {
  approve: 'admin_approved',
  quarantine: 'admin_quarantined',
  reject: 'admin_rejected',
} as const

// Admin moderation action on a single task. Idempotent (re-applying the
// same action just re-confirms it) and never deletes the task — only ever
// an UPDATE to moderation_status, same as every other decision path.
export async function PUT(request: NextRequest, { params }: { params: { taskId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const { action, note } = body
  if (!action || !(action in ACTION_TO_STATUS)) {
    return NextResponse.json({ error: "action must be 'approve', 'quarantine', or 'reject'" }, { status: 400 })
  }

  const db = getSupabase()
  const { data: task } = await db.from('tasks').select('*').eq('id', params.taskId).single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const newStatus = ACTION_TO_STATUS[action as keyof typeof ACTION_TO_STATUS]

  const { data: updated, error } = await db
    .from('tasks')
    .update({ moderation_status: newStatus, moderated_at: new Date().toISOString(), moderated_by: 'admin:manual' })
    .eq('id', params.taskId)
    .select()
    .single()
  if (error || !updated) return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })

  await auditLog({
    action: `task_moderation_${action}`,
    resource_type: 'task',
    resource_id: params.taskId,
    details: { previous_status: task.moderation_status, new_status: newStatus, note },
  })
  await recordModerationEvent({
    taskId: params.taskId,
    eventType: ACTION_TO_EVENT[action as keyof typeof ACTION_TO_EVENT],
    actorType: 'admin',
    actorId: 'admin',
    decision: newStatus === 'approved' ? 'allow' : newStatus === 'quarantined' ? 'quarantine' : 'reject',
    notes: note || undefined,
  })

  // A task moving into 'approved' needs the exact same publish side effects
  // POST /tasks would have fired at creation — but only the FIRST time it
  // is ever published, or approved -> quarantined (e.g. reported) ->
  // re-approved would re-fire task.created webhooks and re-run auto-bid on
  // a task agents already saw once. published_at is a separate, one-way
  // flag from moderation_status specifically to guard this, and the
  // UPDATE ... WHERE published_at IS NULL below makes "publish exactly
  // once" atomic even under a concurrent double-approval.
  let published = false
  if (newStatus === 'approved') {
    const { data: firstPublish } = await db
      .from('tasks')
      .update({ published_at: new Date().toISOString() })
      .eq('id', params.taskId)
      .is('published_at', null)
      .select('id')
      .maybeSingle()

    if (firstPublish) {
      fireWebhooks('task.created', { task_id: task.id, title: task.title, category: task.category, budget_max_eur: task.budget_max_eur })
      await runAutoBids({
        id: task.id,
        title: task.title,
        category: task.category,
        required_capabilities: task.required_capabilities,
        required_languages: task.required_languages,
        budget_min_eur: task.budget_min_eur,
        budget_max_eur: task.budget_max_eur,
        deadline_hours: task.deadline_hours,
      })
      if (task.buyer_email && typeof task.buyer_email === 'string' && task.buyer_email.includes('@')) {
        const buyerToken = await signToken({ role: 'buyer', task_id: task.id, org_id: task.posted_by_org_id, buyer_email: task.buyer_email }, '30d')
        sendTaskCreated({
          to: task.buyer_email,
          taskTitle: task.title,
          taskId: task.id,
          buyerToken,
          budgetMax: task.budget_max_eur,
        }).catch(console.error)
      }
      published = true
    }
  }

  return NextResponse.json({ ...updated, published })
}
