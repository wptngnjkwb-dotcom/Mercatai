import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { fireWebhooks } from '@/lib/server/webhooks'
import { recordAffiliateEarning } from '@/lib/server/affiliate'
import { agentIdentityForWebhook } from '@/lib/server/agentVisibility'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  // 1. Autentizace — buyer token for this task, or admin token
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized — provide buyer_token in Authorization header' }, { status: 401 })

  const isBuyer = token.role === 'buyer' && token.task_id === params.id
  const isAdmin = token.tier === 'admin'

  if (!isBuyer && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only the task buyer can approve' }, { status: 403 })
  }

  const db = getSupabase()

  // Task and payment are read together: which answer is correct depends on
  // the combination, so the task status alone cannot be checked first.
  const [{ data: task, error: taskError }, { data: tx, error: txError }] = await Promise.all([
    db.from('tasks').select('*').eq('id', params.id).single(),
    db.from('transactions').select('*').eq('task_id', params.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  if (taskError && taskError.code !== 'PGRST116') return NextResponse.json({ error: 'Task could not be loaded' }, { status: 500 })
  if (txError) return NextResponse.json({ error: 'Payment could not be loaded' }, { status: 500 })
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  if (tx?.escrow_status === 'released') {
    // Completed + released is the settled end state — repeat approvals are
    // a no-op rather than an error.
    if (task.status === 'completed') {
      return NextResponse.json({ message: 'Already released' }, { status: 200 })
    }
    // A released payment on a task that never completed means the two
    // records disagree. Reporting success here would paper over it.
    if (task.status === 'review') {
      return NextResponse.json({
        error: 'Payment is released but the task is still in review — inconsistent state, needs manual review',
        task_status: task.status,
        escrow_status: tx.escrow_status,
      }, { status: 409 })
    }
  }

  if (task.status !== 'review') return NextResponse.json({ error: 'Task is not in review' }, { status: 400 })

  // 2. Capture/verify the real Stripe payment before atomically finalizing
  // task, transaction, reputation, free-task accounting and audit in DB.
  if (!tx) return NextResponse.json({ error: 'No payment found for this task — cannot approve without escrow' }, { status: 402 })

  // Nothing was ever captured for a payment that is still pending (card
  // never confirmed, SEPA still settling) or that failed. Approving here
  // would mark the transaction released and credit the agent for money the
  // buyer never paid — and 'released' would then block both the release and
  // refund paths, which only act on 'held'.
  if (tx.escrow_status !== 'held') {
    return NextResponse.json({
      error: `Payment is not funded yet (status: ${tx.escrow_status}) — cannot approve`,
      escrow_status: tx.escrow_status,
    }, { status: 402 })
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  }
  if (!tx.stripe_payment_intent_id?.startsWith('pi_')) {
    return NextResponse.json({ error: 'Funded transaction has no valid Stripe payment reference' }, { status: 409 })
  }
  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
    if (intent.capture_method === 'manual' && intent.status === 'requires_capture') {
      await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
    } else if (intent.capture_method === 'manual' && intent.status !== 'succeeded') {
      return NextResponse.json({ error: `Card authorization is not capturable (Stripe status: ${intent.status})` }, { status: 409 })
    } else if (intent.capture_method !== 'manual' && intent.status !== 'succeeded') {
      return NextResponse.json({ error: `Automatic payment is not settled (Stripe status: ${intent.status})` }, { status: 409 })
    }
  } catch (stripeErr) {
    console.error('Stripe capture failed:', stripeErr)
    return NextResponse.json({ error: 'Payment capture failed — task was not finalized' }, { status: 502 })
  }

  const { data: finalizedData, error: finalizedError } = await db.rpc('finalize_funded_task', {
    p_task_id: params.id,
    p_transaction_id: tx.id,
    p_reason: 'buyer_approved',
  })
  if (finalizedError) {
    // Stripe may already have captured the card. Any DB failure after that
    // must remain retryable and visible to monitoring, never be presented as
    // a normal client conflict which a caller might abandon.
    return NextResponse.json({ error: 'Payment was captured but task finalization must be retried' }, { status: 500 })
  }
  const finalized = Array.isArray(finalizedData) ? finalizedData[0] : finalizedData
  if (!finalized || finalized.task_status !== 'completed' || finalized.transaction_status !== 'released') {
    return NextResponse.json({ error: 'Task finalization was not confirmed' }, { status: 500 })
  }

  if (finalized.newly_completed) {
    // Third-party developer webhooks never learn a private agent's identity.
    fireWebhooks('task.completed', {
      task_id: params.id,
      agent_payout_eur: Number(finalized.agent_payout_eur),
      ...(await agentIdentityForWebhook(db, finalized.assigned_agent_id)),
    })

    if (Number(finalized.platform_fee_eur) > 0) {
      recordAffiliateEarning(params.id, Number(finalized.platform_fee_eur)).catch(console.error)
    }
  }

  return NextResponse.json({ id: params.id, status: 'completed', transaction_status: 'released' })
}
