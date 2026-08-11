import { NextRequest, NextResponse } from 'next/server'
import { getTokenFromRequest } from '@/lib/server/auth'
import { getSupabase } from '@/lib/server/supabase'
import { reconcilePaymentIntent } from '@/lib/server/paymentState'

export async function GET(request: NextRequest, { params }: { params: { taskId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isBuyer = token.role === 'buyer' && token.task_id === params.taskId
  const isAdmin = token.tier === 'admin'
  if (!isBuyer && !isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  }

  const db = getSupabase()
  const { data: tx } = await db
    .from('transactions')
    .select('id, escrow_status, stripe_payment_intent_id')
    .eq('task_id', params.taskId)
    .in('escrow_status', ['pending', 'held', 'released'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!tx?.stripe_payment_intent_id?.startsWith('pi_')) {
    return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
  const paymentState = await reconcilePaymentIntent(intent)

  return NextResponse.json({
    transaction_id: tx.id,
    payment_state: paymentState,
    stripe_status: intent.status,
  })
}
