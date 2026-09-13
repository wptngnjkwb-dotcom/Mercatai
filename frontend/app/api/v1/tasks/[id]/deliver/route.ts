import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { agentIdentityForWebhook } from '@/lib/server/agentVisibility'
import { attachPublicTaskFields } from '@/lib/server/publicTaskFields'
import { computeExecutionDecision } from '@/lib/server/executionAuthorization'

const DELIVERY_NOTE_MAX_LENGTH = 50_000

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const deliveryNote = typeof body?.delivery_note === 'string' ? body.delivery_note.trim() : ''
  if (!deliveryNote) {
    return NextResponse.json({ error: 'delivery_note must be a non-empty string' }, { status: 400 })
  }
  if (deliveryNote.length > DELIVERY_NOTE_MAX_LENGTH) {
    return NextResponse.json({ error: `delivery_note must be at most ${DELIVERY_NOTE_MAX_LENGTH} characters` }, { status: 400 })
  }
  const db = getSupabase()

  const { data: task, error: taskError } = await db
    .from('tasks')
    .select('id,status,assigned_agent_id,posted_by_org_id,archived_at')
    .eq('id', params.id)
    .maybeSingle()
  if (taskError) return NextResponse.json({ error: 'Failed to load task' }, { status: 500 })
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const isAdmin = token.tier === 'admin'
  const isAssignedAgent = typeof token.agent_id === 'string' && token.agent_id === task.assigned_agent_id
  if (!isAdmin && !isAssignedAgent) {
    return NextResponse.json({ error: 'Forbidden — only the assigned agent can deliver this task' }, { status: 403 })
  }

  try {
    // Use the same canonical server-derived is_demo/funding_status source as
    // every public Task response. Admin is an explicit delivery override,
    // but never an override for demo/archive/payment/workflow safeguards.
    const [publicTask] = await attachPublicTaskFields(db, [task], token)
    const decision = computeExecutionDecision({
      isDemo: publicTask.is_demo,
      status: task.status,
      fundingStatus: publicTask.funding_status,
      callerAgentId: isAdmin ? task.assigned_agent_id : token.agent_id,
      assignedAgentId: task.assigned_agent_id,
      hasExistingBid: false,
    })

    if (task.archived_at || decision.execution_authorized !== true) {
      const nextAction = task.archived_at ? 'closed' : decision.next_action
      const waitingForFunding = !task.archived_at
        && !publicTask.is_demo
        && (publicTask.funding_status === 'unfunded' || publicTask.funding_status === 'funding_pending')
      return NextResponse.json({
        error: waitingForFunding
          ? 'Payment has not been confirmed; delivery is not authorized'
          : 'Delivery is not authorized for this task state',
        execution_authorized: false,
        next_action: nextAction,
      }, { status: waitingForFunding ? 402 : 409 })
    }

    // The status predicate is the concurrency lock: only one of two
    // simultaneous deliveries can win this transition and therefore only
    // that request may run the effects below.
    const { data, error } = await db
      .from('tasks')
      .update({ status: 'review', delivery_note: deliveryNote })
      .eq('id', params.id)
      .eq('status', 'in_progress')
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: 'Delivery could not be recorded' }, { status: 500 })
    if (!data) {
      return NextResponse.json({
        error: 'Task state changed before delivery could be recorded',
        execution_authorized: false,
        next_action: 'closed',
      }, { status: 409 })
    }

    const reviewDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const { error: txError } = await db.from('transactions')
      .update({ review_deadline_at: reviewDeadline })
      .eq('task_id', params.id)
      .eq('escrow_status', 'held')
    if (txError) return NextResponse.json({ error: 'Delivery review window could not be recorded' }, { status: 500 })

    await auditLog({ action: 'task_delivered', resource_type: 'task', resource_id: params.id })
    // Third-party developer webhooks never learn a private agent's identity
    // — see frontend/lib/server/agentVisibility.ts.
    void fireWebhooks('task.delivered', { task_id: params.id, ...(await agentIdentityForWebhook(db, task.assigned_agent_id)) })
    return NextResponse.json(data)
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Delivery authorization could not be verified' }, { status: 500 })
  }
}
