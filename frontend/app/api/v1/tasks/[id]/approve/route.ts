import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { applyReputationEvent } from '@/lib/server/reputation'
import { fireWebhooks } from '@/lib/server/webhooks'
import { recordAffiliateEarning } from '@/lib/server/affiliate'

const MAX_AMOUNT_WITHOUT_KYC = 10_000

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
  const [{ data: task }, { data: tx }] = await Promise.all([
    db.from('tasks').select('*').eq('id', params.id).single(),
    db.from('transactions').select('*').eq('task_id', params.id).maybeSingle(),
  ])

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

  // 2. Skutečné uvolnění escrow přes Stripe capture
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

  if (tx && tx.escrow_status === 'held' && process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
      if (intent.capture_method === 'manual' && intent.status === 'requires_capture') {
        await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
      } else if (intent.capture_method === 'manual' && intent.status !== 'succeeded') {
        return NextResponse.json({ error: `Card authorization is not capturable (Stripe status: ${intent.status})` }, { status: 409 })
      }
    } catch (stripeErr) {
      console.error('Stripe capture failed:', stripeErr)
      return NextResponse.json({ error: 'Payment capture failed — escrow not released' }, { status: 502 })
    }
  }

  const { data, error } = await db
    .from('tasks')
    .update({ status: 'completed' })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (task.assigned_agent_id) {
    await Promise.all([
      db.from('transactions')
        .update({ escrow_status: 'released', released_at: new Date().toISOString() })
        .eq('task_id', params.id),
      applyReputationEvent(task.assigned_agent_id, 'task_completed', params.id),
    ])

    // Snížit free_tasks_remaining pokud byl task zdarma (platform_fee_eur = 0)
    if (tx.platform_fee_eur === 0) {
      const { data: agentData } = await db.from('agents')
        .select('free_tasks_remaining')
        .eq('id', task.assigned_agent_id)
        .single()
      if (agentData && agentData.free_tasks_remaining > 0) {
        await db.from('agents')
          .update({ free_tasks_remaining: agentData.free_tasks_remaining - 1 })
          .eq('id', task.assigned_agent_id)
      }
    }
  }

  await auditLog({
    action: 'task_approved_escrow_released',
    resource_type: 'task',
    resource_id: params.id,
    details: { transaction_id: tx?.id, agent_payout_eur: tx?.agent_payout_eur },
  })

  fireWebhooks('task.completed', { task_id: params.id, agent_payout_eur: tx?.agent_payout_eur, agent_id: task.assigned_agent_id })

  // Affiliate: record 30% share for the referring API client (fire-and-forget)
  if (tx?.platform_fee_eur > 0) {
    recordAffiliateEarning(params.id, tx.platform_fee_eur).catch(console.error)
  }

  return NextResponse.json(data)
}
