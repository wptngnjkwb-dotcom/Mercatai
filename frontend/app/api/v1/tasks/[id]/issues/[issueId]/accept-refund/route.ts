import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { cancelOrRefundHeldPayment } from '@/lib/server/stripeRefund'

// POST /api/v1/tasks/{id}/issues/{issueId}/accept-refund
// The ONLY way a quality issue ever results in a refund — the assigned
// agent explicitly, voluntarily authorizing it. Neither the buyer nor a
// Mercatai admin can force this outcome; see
// frontend/app/api/v1/tasks/[id]/issues/route.ts and
// frontend/app/api/v1/admin/resolve/[taskId]/route.ts (now 410) for the
// two paths that deliberately cannot. Reuses the exact same Stripe
// cancel-or-refund branch and finalize_task_refund RPC every other refund
// path in this app already uses — see
// frontend/lib/server/stripeRefund.ts.
export async function POST(request: NextRequest, { params }: { params: { id: string; issueId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()
  const { data: issue } = await db
    .from('quality_issues')
    .select('id, task_id, status, assigned_agent_id')
    .eq('id', params.issueId)
    .maybeSingle()
  if (!issue || issue.task_id !== params.id) {
    return NextResponse.json({ error: 'Quality issue not found' }, { status: 404 })
  }

  const isAssignedAgent = typeof token.agent_id === 'string' && token.agent_id === issue.assigned_agent_id
  if (!isAssignedAgent) {
    return NextResponse.json({ error: 'Forbidden — only the assigned agent can voluntarily accept this refund' }, { status: 403 })
  }
  if (issue.status !== 'open') {
    return NextResponse.json({ error: 'This quality issue is already resolved' }, { status: 409 })
  }

  const { data: tx, error: txReadError } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.id)
    .eq('escrow_status', 'held')
    .maybeSingle()
  if (txReadError) return NextResponse.json({ error: 'Payment could not be loaded' }, { status: 500 })
  if (!tx) return NextResponse.json({ error: 'No held transaction found — cannot refund' }, { status: 404 })

  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  if (!tx.stripe_payment_intent_id?.startsWith('pi_')) {
    return NextResponse.json({ error: 'Held transaction has no valid Stripe payment reference' }, { status: 409 })
  }

  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const result = await cancelOrRefundHeldPayment(stripe, tx, `mercatai-quality-issue-refund-${tx.id}`)
    if (result.outcome === 'not_possible') {
      return NextResponse.json({ error: `Stripe payment cannot be refunded from status ${result.stripeStatus}` }, { status: 409 })
    }
  } catch (stripeErr) {
    console.error('Stripe quality-issue refund failed', stripeErr)
    return NextResponse.json({ error: 'Stripe refund failed' }, { status: 502 })
  }

  const { data: finalizedData, error: finalizedError } = await db.rpc('finalize_task_refund', {
    p_task_id: params.id,
    p_transaction_id: tx.id,
    p_outcome: 'quality_issue_agent_refund',
    p_reason: `quality issue ${issue.id} — agent voluntarily accepted a full refund`,
  })
  if (finalizedError) {
    return NextResponse.json({ error: 'Stripe refund succeeded but database finalization must be retried' }, { status: 500 })
  }
  const finalized = Array.isArray(finalizedData) ? finalizedData[0] : finalizedData
  if (!finalized || finalized.transaction_status !== 'refunded' || finalized.task_status !== 'cancelled') {
    return NextResponse.json({ error: 'Refund finalization was not confirmed' }, { status: 500 })
  }

  return NextResponse.json({
    id: tx.id,
    quality_issue_id: issue.id,
    escrow_status: 'refunded',
    gross_amount_eur: tx.gross_amount_eur,
    message: 'Full refund accepted by the agent and processed.',
  })
}
