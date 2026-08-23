import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest, signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { runAutoBids } from '@/lib/server/autobid'
import { sendTaskCreated } from '@/lib/server/email'
import { recordModerationEvent } from '@/lib/server/taskModeration/audit'

const MAX_REASONS_LENGTH = 2000

// Resolve a pending appeal. 'overturn' makes the task approved and public —
// exactly like a fresh admin approval, since an appeal only ever exists for
// a quarantined/rejected task (enforced at appeal submission). 'uphold'
// leaves the task's moderation_status untouched. Every resolution requires
// a statement_of_reasons — this is the buyer-facing explanation of why the
// original decision stands or was reversed, not an internal note.
export async function PUT(request: NextRequest, { params }: { params: { appealId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const { resolution, statement_of_reasons } = body
  if (resolution !== 'uphold' && resolution !== 'overturn') {
    return NextResponse.json({ error: "resolution must be 'uphold' or 'overturn'" }, { status: 400 })
  }
  if (!statement_of_reasons || typeof statement_of_reasons !== 'string' || statement_of_reasons.trim().length === 0) {
    return NextResponse.json({ error: 'statement_of_reasons is required' }, { status: 400 })
  }
  if (statement_of_reasons.length > MAX_REASONS_LENGTH) {
    return NextResponse.json({ error: `statement_of_reasons must be at most ${MAX_REASONS_LENGTH} characters` }, { status: 400 })
  }

  const db = getSupabase()

  const { data: appeal } = await db.from('task_moderation_appeals').select('*').eq('id', params.appealId).single()
  if (!appeal) return NextResponse.json({ error: 'Appeal not found' }, { status: 404 })
  if (appeal.status !== 'pending') {
    return NextResponse.json({ error: 'This appeal has already been resolved' }, { status: 409 })
  }

  const { data: task } = await db.from('tasks').select('*').eq('id', appeal.task_id).single()
  if (!task) return NextResponse.json({ error: 'The appealed task no longer exists' }, { status: 404 })

  const newAppealStatus = resolution === 'overturn' ? 'overturned' : 'upheld'
  const { data: updatedAppeal, error } = await db
    .from('task_moderation_appeals')
    .update({ status: newAppealStatus, statement_of_reasons, resolved_by: 'admin', resolved_at: new Date().toISOString() })
    .eq('id', params.appealId)
    .select()
    .single()
  if (error || !updatedAppeal) return NextResponse.json({ error: 'Failed to resolve appeal' }, { status: 500 })

  await auditLog({
    action: 'task_appeal_resolved',
    resource_type: 'task',
    resource_id: appeal.task_id,
    details: { appeal_id: appeal.id, resolution },
  })

  if (resolution === 'overturn') {
    await db
      .from('tasks')
      .update({ moderation_status: 'approved', moderated_at: new Date().toISOString(), moderated_by: 'admin:appeal' })
      .eq('id', task.id)

    await recordModerationEvent({
      taskId: task.id,
      eventType: 'appeal_resolved',
      actorType: 'admin',
      actorId: 'admin',
      decision: 'allow',
      notes: statement_of_reasons,
    })

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
  } else {
    await recordModerationEvent({
      taskId: task.id,
      eventType: 'appeal_resolved',
      actorType: 'admin',
      actorId: 'admin',
      notes: statement_of_reasons,
    })
  }

  return NextResponse.json({
    appeal_id: updatedAppeal.id,
    status: updatedAppeal.status,
    task_id: task.id,
    task_moderation_status: resolution === 'overturn' ? 'approved' : task.moderation_status,
    statement_of_reasons: updatedAppeal.statement_of_reasons,
  })
}
