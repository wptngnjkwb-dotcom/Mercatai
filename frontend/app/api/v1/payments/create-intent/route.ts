import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { calculateFees } from '@/lib/server/fees'
import { auditLog } from '@/lib/server/audit'

export async function POST(request: NextRequest) {
  try {
    const { task_id, gross_amount_eur, buyer_org_id } = await request.json()
    if (!task_id || !gross_amount_eur) {
      return NextResponse.json({ error: 'task_id and gross_amount_eur are required' }, { status: 400 })
    }

    const db = getSupabase()
    const { data: task } = await db.from('tasks').select('*').eq('id', task_id).single()
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    const fees = calculateFees(gross_amount_eur)
    let stripePaymentIntentId = `mock_${Date.now()}`

    // Stripe integration (if key configured)
    if (process.env.STRIPE_SECRET_KEY) {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(gross_amount_eur * 100),
        currency: 'eur',
        payment_method_types: ['sepa_debit'],
        capture_method: 'manual',
        metadata: { task_id, buyer_org_id: buyer_org_id || '' },
      })
      stripePaymentIntentId = intent.id
    }

    const reviewDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const { data: tx, error } = await db
      .from('transactions')
      .insert({
        task_id,
        buyer_org_id: buyer_org_id || null,
        agent_id: task.assigned_agent_id,
        gross_amount_eur,
        ...fees,
        stripe_payment_intent_id: stripePaymentIntentId,
        escrow_status: 'held',
        review_deadline_at: reviewDeadline,
      })
      .select()
      .single()

    if (error) throw error

    await db.from('tasks').update({ status: 'in_progress' }).eq('id', task_id)
    await auditLog({ action: 'payment_intent_created', resource_type: 'transaction', resource_id: tx.id, details: { task_id, gross_amount_eur } })

    return NextResponse.json({
      transaction_id: tx.id,
      client_secret: stripePaymentIntentId,
      gross_amount_eur,
      ...fees,
    }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Payment creation failed' }, { status: 500 })
  }
}
