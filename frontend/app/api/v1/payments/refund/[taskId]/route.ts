import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export async function POST(request: NextRequest, { params }: { params: { taskId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Refunds move money — restrict to the task's buyer or an admin.
  const isBuyer = token.role === 'buyer' && token.task_id === params.taskId
  const isAdmin = token.tier === 'admin'
  if (!isBuyer && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only the task buyer or an admin can refund' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const db = getSupabase()

  const { data: tx } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .eq('escrow_status', 'held')
    .single()

  if (!tx) return NextResponse.json({ error: 'No held transaction found — cannot refund' }, { status: 404 })

  // Cancel an uncaptured card hold; a SEPA charge has already settled to
  // the agent (SEPA has no manual capture), so it needs a real refund —
  // cancelling a succeeded intent would error.
  if (process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
      if (intent.status === 'succeeded') {
        await stripe.refunds.create({
          payment_intent: tx.stripe_payment_intent_id,
          reverse_transfer: true,
          refund_application_fee: true,
        })
      } else {
        await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id)
      }
    } catch (stripeErr: unknown) {
      const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
      return NextResponse.json({ error: `Stripe refund failed: ${msg}` }, { status: 502 })
    }
  }

  const { error: txErr } = await db
    .from('transactions')
    .update({ escrow_status: 'refunded' })
    .eq('id', tx.id)
  if (txErr) console.error('Failed to update transaction status:', txErr)

  const { error: taskErr } = await db
    .from('tasks')
    .update({ status: 'disputed' })
    .eq('id', params.taskId)
  if (taskErr) console.error('Failed to update task status:', taskErr)

  await auditLog({
    action: 'payment_refunded',
    resource_type: 'transaction',
    resource_id: tx.id,
    details: {
      task_id: params.taskId,
      gross_amount_eur: tx.gross_amount_eur,
      reason: body.reason || 'not specified',
    },
  })

  return NextResponse.json({
    id: tx.id,
    escrow_status: 'refunded',
    gross_amount_eur: tx.gross_amount_eur,
    message: 'Payment refunded to buyer',
  })
}
