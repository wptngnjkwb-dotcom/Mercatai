import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { calculateFees } from '@/lib/server/fees'
import { getPlatformFeePercent } from '@/lib/server/settings'
import { auditLog } from '@/lib/server/audit'
import { getTokenFromRequest } from '@/lib/server/auth'

const MAX_AMOUNT_WITHOUT_KYC = 10_000
const MIN_AMOUNT = 1

export async function POST(request: NextRequest) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { task_id, payment_method: requestedMethod } = await request.json()
    if (!task_id) {
      return NextResponse.json({ error: 'task_id is required' }, { status: 400 })
    }

    // The buyer token is bound to a specific task at issuance (see
    // /api/v1/tasks and /api/v1/store/[listingId]/hire) — task_id and
    // buyer_org_id must come from the verified token, never from the
    // request body, or any caller with any valid token could fund an
    // arbitrary task under an arbitrary organization.
    const isBuyer = token.role === 'buyer' && token.task_id === task_id
    const isAdmin = token.tier === 'admin'
    if (!isBuyer && !isAdmin) {
      return NextResponse.json({ error: 'Forbidden — only the task buyer can fund this task' }, { status: 403 })
    }
    const buyer_org_id = isAdmin ? undefined : (token.org_id as string)

    const db = getSupabase()

    // Zkontrolovat že task existuje a má správný stav
    const { data: task } = await db.from('tasks').select('*, agents!assigned_agent_id(id, stripe_account_id, stripe_onboarding_completed, free_tasks_remaining)').eq('id', task_id).single()
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    if (!['assigned', 'open', 'bidding'].includes(task.status)) {
      return NextResponse.json({ error: `Task status '${task.status}' does not allow payment` }, { status: 400 })
    }
    if (!task.assigned_agent_id) {
      return NextResponse.json({ error: 'Task has no assigned agent yet' }, { status: 400 })
    }
    const resolvedBuyerOrgId = buyer_org_id ?? task.posted_by_org_id
    if (isAdmin && !resolvedBuyerOrgId) {
      return NextResponse.json({ error: 'Task has no buyer organization on record' }, { status: 400 })
    }

    // The amount is never trusted from the client — it's the accepted
    // bid's price for this task, full stop.
    const { data: acceptedBid } = await db
      .from('bids')
      .select('price_eur')
      .eq('task_id', task_id)
      .eq('status', 'accepted')
      .maybeSingle()
    if (!acceptedBid) {
      return NextResponse.json({ error: 'No accepted bid found for this task' }, { status: 400 })
    }
    const gross_amount_eur = Number(acceptedBid.price_eur)

    if (typeof gross_amount_eur !== 'number' || gross_amount_eur < MIN_AMOUNT) {
      return NextResponse.json({ error: `Minimum transaction amount is €${MIN_AMOUNT}` }, { status: 400 })
    }
    if (gross_amount_eur > MAX_AMOUNT_WITHOUT_KYC) {
      return NextResponse.json({
        error: `Transactions over €${MAX_AMOUNT_WITHOUT_KYC} require KYC verification. Contact mercatai@seznam.cz`,
      }, { status: 403 })
    }

    // Zkontrolovat že agent má dokončený Stripe Connect onboarding
    const agentStripeAccount = (task.agents as any)?.stripe_account_id
    const agentOnboardingDone = (task.agents as any)?.stripe_onboarding_completed
    if (!agentStripeAccount || !agentOnboardingDone) {
      return NextResponse.json({
        error: 'Agent has not completed Stripe Connect onboarding. Payment cannot be created until the agent links their payout account.',
        stripe_onboarding_required: true,
      }, { status: 402 })
    }

    // Zabránit dvojité platbě — zkontrolovat existující transakci
    const { data: existingTx } = await db
      .from('transactions')
      .select('id, escrow_status')
      .eq('task_id', task_id)
      .in('escrow_status', ['held', 'released'])
      .maybeSingle()

    if (existingTx) {
      return NextResponse.json({
        error: `Payment already exists for this task (status: ${existingTx.escrow_status})`,
        transaction_id: existingTx.id,
      }, { status: 409 })
    }

    // Zkontrolovat zda agent má nárok na free task (prvních 10 zdarma)
    const agentFreeTasksRemaining = (task.agents as any)?.free_tasks_remaining ?? 0
    const isFreeTask = agentFreeTasksRemaining > 0

    // Výpočet poplatků — platform fee = 0 pro free tasks
    const fees = calculateFees(gross_amount_eur, await getPlatformFeePercent())
    if (isFreeTask) {
      fees.platform_fee_eur = 0
      fees.agent_payout_eur = Math.round((gross_amount_eur - fees.stripe_fee_eur) * 100) / 100
    }

    // Ověřit že součet sedí (ochrana proti rounding error)
    const sum = fees.stripe_fee_eur + fees.platform_fee_eur + fees.agent_payout_eur
    if (Math.abs(sum - gross_amount_eur) > 0.02) {
      console.error('Fee rounding error:', { gross_amount_eur, sum, fees })
      return NextResponse.json({ error: 'Fee calculation error' }, { status: 500 })
    }

    // SEPA Direct Debit does not support manual capture, so the two methods
    // cannot share one intent. Card = authorization hold captured on buyer
    // approval. SEPA = charged immediately, funds move to the agent before
    // approval, and a dispute becomes a refund rather than a released hold.
    const paymentMethod: 'card' | 'sepa_debit' = requestedMethod === 'sepa_debit' ? 'sepa_debit' : 'card'
    const captureMode: 'manual' | 'immediate' = paymentMethod === 'card' ? 'manual' : 'immediate'

    let stripePaymentIntentId = `mock_${Date.now()}`
    let stripeClientSecret = `mock_secret_${Date.now()}`

    if (process.env.STRIPE_SECRET_KEY) {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(gross_amount_eur * 100),
        currency: 'eur',
        payment_method_types: [paymentMethod],
        ...(captureMode === 'manual' ? { capture_method: 'manual' as const } : {}),
        // on_behalf_of: agent je merchant of record (Direct Charges model)
        // → Mercatai nevstupuje do platebního vztahu jako platební instituce
        on_behalf_of: agentStripeAccount,
        // Free task: application_fee_amount = pouze Stripe fee (platform fee odpuštěn)
        // Normální task: platform fee + stripe fee
        application_fee_amount: Math.round((fees.platform_fee_eur + fees.stripe_fee_eur) * 100),
        transfer_data: {
          destination: agentStripeAccount,
        },
        metadata: {
          task_id,
          buyer_org_id: resolvedBuyerOrgId,
          agent_id: task.assigned_agent_id,
          platform: 'mercatai',
          free_task: isFreeTask ? 'true' : 'false',
          capture_mode: captureMode,
        },
      })
      stripePaymentIntentId = intent.id
      if (!intent.client_secret) throw new Error('Stripe returned no client_secret')
      stripeClientSecret = intent.client_secret
    }

    const reviewDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

    const { data: tx, error } = await db
      .from('transactions')
      .insert({
        task_id,
        buyer_org_id: resolvedBuyerOrgId,
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

    await auditLog({
      action: 'payment_intent_created',
      resource_type: 'transaction',
      resource_id: tx.id,
      details: {
        task_id,
        gross_amount_eur,
        ...fees,
        free_task: isFreeTask,
        stripe_id: stripePaymentIntentId,
        review_deadline_at: reviewDeadline,
      },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })

    return NextResponse.json({
      transaction_id: tx.id,
      client_secret: stripeClientSecret,
      gross_amount_eur,
      ...fees,
      free_task: isFreeTask,
      free_tasks_remaining_after: isFreeTask ? agentFreeTasksRemaining - 1 : agentFreeTasksRemaining,
      review_deadline_at: reviewDeadline,
      capture_mode: captureMode,
    }, { status: 201 })

  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Payment creation failed' }, { status: 500 })
  }
}
