import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { fireWebhooks } from '@/lib/server/webhooks'
import { recordAffiliateEarning } from '@/lib/server/affiliate'
import { agentIdentityForWebhook } from '@/lib/server/agentVisibility'

// Vercel Cron — spouští se každou hodinu
// Uvolní escrow pro tasky kde buyer nereagoval 48h po doručení

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
    .eq('tasks.status', 'review')

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
      // Capture card holds. SEPA uses automatic capture and is already
      // settled before its transaction can reach the held state.
      if (process.env.STRIPE_SECRET_KEY && tx.stripe_payment_intent_id?.startsWith('pi_')) {
        const Stripe = (await import('stripe')).default
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
        const intent = await stripe.paymentIntents.retrieve(tx.stripe_payment_intent_id)
        if (intent.capture_method === 'manual' && intent.status === 'requires_capture') {
          await stripe.paymentIntents.capture(tx.stripe_payment_intent_id)
        } else if (intent.capture_method === 'manual' && intent.status !== 'succeeded') {
          throw new Error(`Card authorization is not capturable (Stripe status: ${intent.status})`)
        } else if (intent.capture_method !== 'manual' && intent.status !== 'succeeded') {
          throw new Error(`Automatic payment has not settled (Stripe status: ${intent.status})`)
        }
      }

      const { data: finalizedData, error: finalizedError } = await db.rpc('finalize_funded_task', {
        p_task_id: tx.task_id,
        p_transaction_id: tx.id,
        p_reason: 'review_deadline_expired_48h',
      })
      if (finalizedError) throw finalizedError
      const finalized = Array.isArray(finalizedData) ? finalizedData[0] : finalizedData
      if (!finalized || finalized.task_status !== 'completed' || finalized.transaction_status !== 'released') {
        throw new Error('Automatic task finalization was not confirmed')
      }
      if (finalized.newly_completed) {
        fireWebhooks('task.completed', {
          task_id: tx.task_id,
          agent_payout_eur: Number(finalized.agent_payout_eur),
          ...(await agentIdentityForWebhook(db, finalized.assigned_agent_id)),
        })
        if (Number(finalized.platform_fee_eur) > 0) {
          recordAffiliateEarning(tx.task_id, Number(finalized.platform_fee_eur)).catch(console.error)
        }
      }

      results.push({ transaction_id: tx.id, task_id: tx.task_id, status: 'released' })
    } catch (err) {
      results.push({ transaction_id: tx.id, status: 'error', error: String(err) })
    }
  }

  return NextResponse.json({ released: results.filter(r => r.status === 'released').length, results })
}
