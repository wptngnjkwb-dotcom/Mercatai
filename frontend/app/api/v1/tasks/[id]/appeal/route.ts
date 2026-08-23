import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { recordModerationEvent } from '@/lib/server/taskModeration/audit'

const MAX_MESSAGE_LENGTH = 2000

// Buyer-token-bound, mirroring /tasks/[id]/dispute — only the buyer who
// received this exact task's token (minted at creation, see POST /tasks)
// can appeal its moderation decision. Admins act directly through the
// moderation queue instead of filing appeals against their own review.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const isBuyer = token.role === 'buyer' && token.task_id === params.id
    if (!isBuyer) {
      return NextResponse.json({ error: 'Forbidden — only this task\'s buyer token can appeal its moderation decision' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { message } = body
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 })
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 })
    }

    const db = getSupabase()

    const { data: task } = await db.from('tasks').select('id, moderation_status').eq('id', params.id).single()
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    if (task.moderation_status !== 'quarantined' && task.moderation_status !== 'rejected') {
      return NextResponse.json({ error: 'This task has no moderation decision to appeal' }, { status: 400 })
    }

    const { data: existingPending } = await db
      .from('task_moderation_appeals')
      .select('id')
      .eq('task_id', task.id)
      .eq('status', 'pending')
      .maybeSingle()
    if (existingPending) {
      return NextResponse.json({ error: 'An appeal is already pending for this task' }, { status: 409 })
    }

    const orgId = typeof token.org_id === 'string' ? token.org_id : null
    if (!orgId) {
      return NextResponse.json({ error: 'Buyer token is missing its organization' }, { status: 400 })
    }

    const { data: appeal, error } = await db
      .from('task_moderation_appeals')
      .insert({ task_id: task.id, buyer_org_id: orgId, message: message.trim(), status: 'pending' })
      .select()
      .single()
    if (error) throw error

    await recordModerationEvent({
      taskId: task.id,
      eventType: 'appeal_submitted',
      actorType: 'buyer',
      actorId: orgId,
      notes: `Buyer appeal submitted (appeal id ${appeal.id}).`,
    })

    return NextResponse.json({
      id: appeal.id,
      status: appeal.status,
      created_at: appeal.created_at,
    }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to submit appeal' }, { status: 500 })
  }
}
