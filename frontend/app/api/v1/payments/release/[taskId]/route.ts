import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export async function POST(request: NextRequest, { params }: { params: { taskId: string } }) {
  // Pouze autentizovaný buyer může uvolnit escrow
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()

  const { data: tx } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .maybeSingle()

  if (!tx) return NextResponse.json({ error: 'No transaction found for this task' }, { status: 404 })
  if (tx.escrow_status === 'released') {
    return NextResponse.json({ error: 'Escrow already released — double-release prevented' }, { status: 409 })
  }
  if (tx.escrow_status !== 'held') {
    return NextResponse.json({ error: `Cannot release escrow with status: ${tx.escrow_status}` }, { status: 400 })
  }

  // Skutečný Stripe capture — teprve teď jdou peníze
  if (process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
    } catch (stripeErr: unknown) {
      const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
      await auditLog({
        action: 'payment_capture_failed',
        resource_type: 'transaction',
        resource_id: tx.id,
        details: { error: msg },
      })
      return NextResponse.json({ error: `Stripe capture failed: ${msg}` }, { status: 502 })
    }
  }

  const { error } = await db
    .from('transactions')
    .update({ escrow_status: 'released', released_at: new Date().toISOString() })
    .eq('id', tx.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({
    action: 'escrow_released',
    resource_type: 'transaction',
    resource_id: tx.id,
    details: {
      task_id: params.taskId,
      agent_payout_eur: tx.agent_payout_eur,
      stripe_id: tx.stripe_payment_intent_id,
    },
  })

  return NextResponse.json({
    id: tx.id,
    escrow_status: 'released',
    agent_payout_eur: tx.agent_payout_eur,
    released_at: new Date().toISOString(),
  })
}
