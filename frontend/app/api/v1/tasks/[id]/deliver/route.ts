import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest, signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { agentIdentityForWebhook } from '@/lib/server/agentVisibility'
import { attachPublicTaskFields } from '@/lib/server/publicTaskFields'
import { computeExecutionDecision } from '@/lib/server/executionAuthorization'
import { sendTaskDelivered } from '@/lib/server/email'

const DELIVERY_NOTE_MAX_LENGTH = 50_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Tells the task's buyer that work was delivered, with a link to the buyer
 * review page and the review deadline. Called only after the atomic delivery
 * RPC confirmed a fresh in_progress -> review transition, so a duplicate or
 * no-op delivery (which the RPC rejects) never emails twice. Non-critical:
 * any failure (lookup, token signing, provider) is logged and swallowed so it
 * can never fail or roll back an already-recorded delivery. The link carries
 * a fresh task-scoped buyer token — the same credential and payload as
 * buyer-access recovery — sent only to the address already stored on the task.
 */
async function notifyBuyerOfDelivery(
  db: ReturnType<typeof getSupabase>,
  taskId: string,
  reviewDeadlineAt: string,
) {
  try {
    const { data: task, error } = await db
      .from('tasks')
      .select('id,title,buyer_email,posted_by_org_id')
      .eq('id', taskId)
      .maybeSingle()
    if (error) throw error
    const buyerEmail = typeof task?.buyer_email === 'string' ? task.buyer_email.trim().toLowerCase() : ''
    if (!task || !EMAIL_RE.test(buyerEmail)) return
    const buyerToken = await signToken({
      role: 'buyer',
      task_id: task.id,
      org_id: task.posted_by_org_id,
      buyer_email: buyerEmail,
    }, '30d')
    await sendTaskDelivered({
      to: buyerEmail,
      taskTitle: typeof task.title === 'string' ? task.title : 'your task',
      taskId: task.id,
      buyerToken,
      reviewDeadlineAt,
    })
  } catch (err) {
    console.error('[deliver] buyer delivery notification failed', err)
  }
}

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

    // The RPC locks the task and its newest funded transaction and commits
    // task->review + transaction.review_deadline_at atomically. It repeats
    // the critical demo/archive/status/funding checks inside PostgreSQL, so
    // a state change between the read above and this write fails closed.
    const { data, error } = await db.rpc('submit_funded_task_delivery', {
      p_task_id: params.id,
      p_expected_agent_id: task.assigned_agent_id,
      p_delivery_note: deliveryNote,
    })

    if (error) {
      if (error.code === 'P0002') return NextResponse.json({ error: 'Task not found' }, { status: 404 })
      if (error.code === '22023') return NextResponse.json({ error: 'Invalid delivery_note' }, { status: 400 })
      if (error.code === 'P0001') {
        return NextResponse.json({
          error: 'Task state changed before delivery could be recorded',
          execution_authorized: false,
          next_action: 'closed',
        }, { status: 409 })
      }
      return NextResponse.json({ error: 'Delivery could not be recorded' }, { status: 500 })
    }

    const result = Array.isArray(data) ? data[0] : data
    if (!result) {
      return NextResponse.json({
        error: 'Delivery transition was not confirmed',
      }, { status: 500 })
    }

    await auditLog({ action: 'task_delivered', resource_type: 'task', resource_id: params.id })
    // Third-party developer webhooks never learn a private agent's identity
    // — see frontend/lib/server/agentVisibility.ts.
    void fireWebhooks('task.delivered', { task_id: params.id, ...(await agentIdentityForWebhook(db, task.assigned_agent_id)) })
    if (result.task_status === 'review' && typeof result.review_deadline_at === 'string') {
      await notifyBuyerOfDelivery(db, params.id, result.review_deadline_at)
    }
    return NextResponse.json({
      id: result.task_id,
      status: result.task_status,
      review_deadline_at: result.review_deadline_at,
    })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Delivery authorization could not be verified' }, { status: 500 })
  }
}
