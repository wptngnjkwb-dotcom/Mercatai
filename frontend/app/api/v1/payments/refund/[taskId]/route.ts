import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

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
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.trim().length > 1000)) {
    return NextResponse.json({ error: 'reason must be text up to 1,000 characters' }, { status: 400 })
  }
  const db = getSupabase()

  const { data: tx, error: txReadError } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .eq('escrow_status', 'held')
    .maybeSingle()

  if (txReadError) return NextResponse.json({ error: 'Payment could not be loaded' }, { status: 500 })
  if (!tx) return NextResponse.json({ error: 'No held transaction found — cannot refund' }, { status: 404 })

  // Cancel an uncaptured card hold; a SEPA charge has already settled to
  // the agent (SEPA has no manual capture), so it needs a real refund —
  // cancelling a succeeded intent would error.
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  if (!tx.stripe_payment_intent_id?.startsWith('pi_')) {
    return NextResponse.json({ error: 'Held transaction has no valid Stripe payment reference' }, { status: 409 })
  }
  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
    if (intent.status === 'succeeded') {
      await stripe.refunds.create({
        payment_intent: tx.stripe_payment_intent_id,
        reverse_transfer: true,
        refund_application_fee: true,
      }, { idempotencyKey: `mercatai-refund-${tx.id}` })
    } else if (intent.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(tx.stripe_payment_intent_id)
    } else if (intent.status === 'canceled') {
      // A previous attempt may have canceled Stripe successfully and then
      // lost the DB response. Continue to the idempotent finalization RPC.
    } else {
      return NextResponse.json({ error: `Stripe payment cannot be refunded from status ${intent.status}` }, { status: 409 })
    }
  } catch (stripeErr) {
    console.error('Stripe refund failed', stripeErr)
    return NextResponse.json({ error: 'Stripe refund failed' }, { status: 502 })
  }

  const { data: finalizedData, error: finalizedError } = await db.rpc('finalize_task_refund', {
    p_task_id: params.taskId,
    p_transaction_id: tx.id,
    p_outcome: 'buyer_refund',
    p_reason: typeof body.reason === 'string' ? body.reason.trim() : 'not specified',
  })
  if (finalizedError) {
    return NextResponse.json({ error: 'Stripe refund succeeded but database finalization must be retried' }, { status: 500 })
  }
  const finalized = Array.isArray(finalizedData) ? finalizedData[0] : finalizedData
  if (!finalized || finalized.transaction_status !== 'refunded' || finalized.task_status !== 'disputed') {
    return NextResponse.json({ error: 'Refund finalization was not confirmed' }, { status: 500 })
  }

  return NextResponse.json({
    id: tx.id,
    escrow_status: 'refunded',
    gross_amount_eur: tx.gross_amount_eur,
    message: 'Payment refunded to buyer',
  })
}
