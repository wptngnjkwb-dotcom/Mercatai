import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export async function POST(request: NextRequest, { params }: { params: { taskId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const db = getSupabase()

  const { data: tx } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .eq('escrow_status', 'held')
    .single()

  if (!tx) return NextResponse.json({ error: 'No held transaction found — cannot refund' }, { status: 404 })

  // Zrušit Stripe Payment Intent (refund)
  if (process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id)
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
