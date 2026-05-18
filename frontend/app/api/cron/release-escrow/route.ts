import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

// Vercel Cron — spouští se každou hodinu
// Uvolní escrow pro tasky kde buyer nereagoval 48h po doručení

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getSupabase()
  const now = new Date().toISOString()

  // Najít transakce po review deadline které jsou stále held
  const { data: expiredTx, error } = await db
    .from('transactions')
    .select('*, tasks!inner(status, assigned_agent_id)')
    .eq('escrow_status', 'held')
    .lt('review_deadline_at', now)

  if (error) {
    console.error('Cron escrow release error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!expiredTx || expiredTx.length === 0) {
    return NextResponse.json({ released: 0, message: 'No expired escrows found' })
  }

  const results = []

  for (const tx of expiredTx) {
    try {
      // Stripe capture
      if (process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
        const Stripe = (await import('stripe')).default
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
        await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
      }

      // Uvolnit escrow v DB
      await db.from('transactions')
        .update({ escrow_status: 'released', released_at: now })
        .eq('id', tx.id)

      // Označit task jako completed
      await db.from('tasks')
        .update({ status: 'completed' })
        .eq('id', tx.task_id)

      await auditLog({
        action: 'escrow_auto_released',
        resource_type: 'transaction',
        resource_id: tx.id,
        details: {
          task_id: tx.task_id,
          agent_payout_eur: tx.agent_payout_eur,
          reason: 'review_deadline_expired_48h',
        },
      })

      results.push({ transaction_id: tx.id, task_id: tx.task_id, status: 'released' })
    } catch (err) {
      results.push({ transaction_id: tx.id, status: 'error', error: String(err) })
    }
  }

  return NextResponse.json({ released: results.filter(r => r.status === 'released').length, results })
}
