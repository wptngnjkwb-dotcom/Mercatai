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
// two paths that deliberately cannot.
//
// Claims the issue in the DB (claim_quality_issue_refund) BEFORE ever
// calling Stripe — not an optimization, a correctness requirement. This
// is the one refund path whose precondition (tasks.status='review') is
// the same state buyer approval and the 48h auto-release cron both
// operate on. A card capture-vs-cancel race is serialized by Stripe's own
// PaymentIntent state machine, but a settled SEPA payment isn't: approval
// never calls Stripe for it at all, so without a DB-side claim taken
// first, both a Stripe refund here AND a concurrent release could
// independently succeed, leaving Stripe saying "refunded" and Mercatai's
// own records saying "released". The claim closes that gap without
// falsely reporting a refund before Stripe succeeds: it leaves the issue
// open, records a private lease token, and finalize_funded_task refuses to
// complete a task while that lease exists.
export async function POST(request: NextRequest, { params }: { params: { id: string; issueId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const agentId = typeof token.agent_id === 'string' ? token.agent_id : null
  if (!agentId) {
    return NextResponse.json({ error: 'Forbidden — only the assigned agent can voluntarily accept this refund' }, { status: 403 })
  }

  const db = getSupabase()

  // Do not acquire a durable refund lease if this deployment cannot call
  // Stripe at all. Once acquired, the lease intentionally blocks approval
  // and auto-release until a safe idempotent retry completes.
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })

  const { data: issueCheck } = await db
    .from('quality_issues')
    .select('id, task_id')
    .eq('id', params.issueId)
    .maybeSingle()
  if (!issueCheck || issueCheck.task_id !== params.id) {
    return NextResponse.json({ error: 'Quality issue not found' }, { status: 404 })
  }

  const { data: claimData, error: claimError } = await db.rpc('claim_quality_issue_refund', {
    p_issue_id: params.issueId,
    p_expected_agent_id: agentId,
  })
  if (claimError) {
    if (claimError.code === 'P0002') return NextResponse.json({ error: 'Quality issue not found' }, { status: 404 })
    if (claimError.code === 'P0001') {
      const message = claimError.message || ''
      if (message.includes('only the assigned agent')) {
        return NextResponse.json({ error: 'Forbidden — only the assigned agent can voluntarily accept this refund' }, { status: 403 })
      }
      return NextResponse.json({ error: 'This quality issue is already resolved' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Quality issue could not be claimed for refund' }, { status: 500 })
  }
  const claim = Array.isArray(claimData) ? claimData[0] : claimData
  if (!claim) return NextResponse.json({ error: 'Quality issue claim was not confirmed' }, { status: 500 })

  if (claim.already_finalized) {
    return NextResponse.json({
      id: claim.transaction_id,
      quality_issue_id: params.issueId,
      escrow_status: 'refunded',
      gross_amount_eur: claim.gross_amount_eur,
      message: 'Full refund was already accepted by the agent and processed.',
    })
  }
  if (!claim.claimed || !claim.claim_token) {
    return NextResponse.json({
      error: 'A refund attempt is already in progress. Retry after a few minutes if it does not complete.',
    }, { status: 409 })
  }

  if (!claim.stripe_payment_intent_id?.startsWith('pi_')) {
    return NextResponse.json({ error: 'Held transaction has no valid Stripe payment reference' }, { status: 409 })
  }

  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const result = await cancelOrRefundHeldPayment(stripe, {
      id: claim.transaction_id,
      stripe_payment_intent_id: claim.stripe_payment_intent_id,
      stripe_charge_model: claim.stripe_charge_model,
      stripe_connected_account_id: claim.stripe_connected_account_id,
    }, `mercatai-quality-issue-refund-${claim.transaction_id}`)
    if (result.outcome === 'not_possible') {
      await db.rpc('record_quality_issue_refund_error', {
        p_issue_id: params.issueId,
        p_claim_token: claim.claim_token,
        p_error: `Stripe payment cannot be refunded from status ${result.stripeStatus}`,
      })
      return NextResponse.json({ error: `Stripe payment cannot be refunded from status ${result.stripeStatus}` }, { status: 409 })
    }
  } catch (stripeErr) {
    console.error('Stripe quality-issue refund failed', stripeErr)
    await db.rpc('record_quality_issue_refund_error', {
      p_issue_id: params.issueId,
      p_claim_token: claim.claim_token,
      p_error: stripeErr instanceof Error ? stripeErr.message : 'Stripe refund failed',
    })
    return NextResponse.json({ error: 'Stripe refund failed' }, { status: 502 })
  }

  const { data: finalizedData, error: finalizedError } = await db.rpc('finalize_quality_issue_refund', {
    p_issue_id: params.issueId,
    p_claim_token: claim.claim_token,
  })
  if (finalizedError) {
    return NextResponse.json({ error: 'Stripe refund succeeded but database finalization must be retried' }, { status: 500 })
  }
  const finalized = Array.isArray(finalizedData) ? finalizedData[0] : finalizedData
  if (!finalized || finalized.transaction_status !== 'refunded' || finalized.task_status !== 'cancelled') {
    return NextResponse.json({ error: 'Refund finalization was not confirmed' }, { status: 500 })
  }

  return NextResponse.json({
    id: claim.transaction_id,
    quality_issue_id: params.issueId,
    escrow_status: 'refunded',
    gross_amount_eur: finalized.gross_amount_eur,
    message: 'Full refund accepted by the agent and processed.',
  })
}
