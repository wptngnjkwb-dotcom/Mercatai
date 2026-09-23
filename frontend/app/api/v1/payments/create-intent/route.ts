import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { calculateFees } from '@/lib/server/fees'
import { getPlatformFeePercent, MAX_TRANSACTION_EUR } from '@/lib/server/settings'
import { auditLog } from '@/lib/server/audit'
import { getTokenFromRequest } from '@/lib/server/auth'
import { reconcilePaymentIntent } from '@/lib/server/paymentState'
import { computeStripeAccountReadiness, isMethodReady, syncOnboardingCompletedFlag } from '@/lib/server/stripeAccountReadiness'
import type Stripe from 'stripe'
import { getOnboardingCountry } from '@/lib/onboardingCountries'
import { isPaymentCountryEnabled } from '@/lib/server/stripeConnectCountries'
import {
  bindDirectChargeContext,
  directChargeCreateOptions,
  paymentContextFromTransaction,
  stripeRequestOptions,
} from '@/lib/server/stripePaymentContext'

const MIN_AMOUNT = 1

export async function POST(request: NextRequest) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { task_id, payment_method: requestedMethod } = await request.json()
    if (!task_id) {
      return NextResponse.json({ error: 'task_id is required' }, { status: 400 })
    }
    if (requestedMethod !== undefined && requestedMethod !== 'card' && requestedMethod !== 'sepa_debit') {
      return NextResponse.json({ error: `payment_method must be 'card' or 'sepa_debit' if provided — got '${requestedMethod}'` }, { status: 400 })
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
    const { data: task, error: taskError } = await db
      .from('tasks')
      .select('*, agents!assigned_agent_id(id, stripe_account_id, stripe_onboarding_completed, free_tasks_remaining), organizations!posted_by_org_id(is_platform_seed)')
      .eq('id', task_id)
      .single()
    if (taskError && taskError.code !== 'PGRST116') {
      return NextResponse.json({ error: 'Task could not be loaded' }, { status: 500 })
    }
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    // Moderation can quarantine a task after bid acceptance (e.g. reported
    // post-publish) — no new money enters escrow for it from that point,
    // regardless of workflow status.
    if (task.moderation_status !== 'approved') {
      return NextResponse.json({ error: 'This task is not available for payment — it is pending review' }, { status: 409 })
    }
    if (task.archived_at || (task.organizations as any)?.is_platform_seed === true) {
      return NextResponse.json({ error: 'Demo or archived tasks cannot be funded' }, { status: 409 })
    }
    if (task.status !== 'assigned') {
      return NextResponse.json({ error: `Task status '${task.status}' does not allow payment` }, { status: 400 })
    }
    if (!task.assigned_agent_id) {
      return NextResponse.json({ error: 'Task has no assigned agent yet' }, { status: 400 })
    }
    const resolvedBuyerOrgId = buyer_org_id ?? task.posted_by_org_id
    if (isAdmin && !resolvedBuyerOrgId) {
      return NextResponse.json({ error: 'Task has no buyer organization on record' }, { status: 400 })
    }

    // Manual capture is supported for cards. SEPA Direct Debit is an
    // asynchronous debit, so it must use automatic capture and remains
    // pending until Stripe confirms settlement by webhook.
    const paymentMethod: 'card' | 'sepa_debit' = requestedMethod === 'sepa_debit' ? 'sepa_debit' : 'card'
    const captureMode: 'manual' | 'immediate' = paymentMethod === 'card' ? 'manual' : 'immediate'

    // The amount is never trusted from the client — it's the accepted
    // bid's price for this task, full stop.
    const { data: acceptedBid, error: acceptedBidError } = await db
      .from('bids')
      .select('id,agent_id,price_eur,delivery_hours')
      .eq('task_id', task_id)
      .eq('status', 'accepted')
      .maybeSingle()
    if (acceptedBidError) return NextResponse.json({ error: 'Accepted bid could not be verified' }, { status: 500 })
    if (!acceptedBid) {
      return NextResponse.json({ error: 'No accepted bid found for this task' }, { status: 400 })
    }
    if (acceptedBid.agent_id !== task.assigned_agent_id) {
      return NextResponse.json({ error: 'Accepted bid does not match the assigned agent' }, { status: 409 })
    }
    const gross_amount_eur = Number(acceptedBid.price_eur)
    const deliveryHours = Number(acceptedBid.delivery_hours)

    if (!Number.isFinite(gross_amount_eur) || gross_amount_eur < MIN_AMOUNT) {
      return NextResponse.json({ error: `Minimum transaction amount is €${MIN_AMOUNT}` }, { status: 400 })
    }
    if (gross_amount_eur > MAX_TRANSACTION_EUR) {
      return NextResponse.json({
        error: `Mercatai currently supports transactions up to €${MAX_TRANSACTION_EUR}. Contact support for a higher-value assignment.`,
      }, { status: 403 })
    }
    if (!Number.isInteger(deliveryHours) || deliveryHours < 1 || deliveryHours > 8760) {
      return NextResponse.json({ error: 'Accepted bid has an invalid delivery SLA' }, { status: 409 })
    }
    // Manual card authorizations are not a safe basis for a long-running job:
    // reserve two days for buyer review and roughly one day for cron/network
    // margin inside the usual seven-day capture window.
    if (paymentMethod === 'card' && deliveryHours > 96) {
      return NextResponse.json({
        error: 'Card-funded tasks currently require delivery within 96 hours. Use SEPA Direct Debit for a longer assignment.',
        maximum_card_delivery_hours: 96,
        supported_alternative: 'sepa_debit',
      }, { status: 400 })
    }

    // Only a missing Stripe account at all is rejected here without a live
    // check — whether an existing account is actually ready is decided
    // below, from Stripe's own current data, not from the stored
    // stripe_onboarding_completed flag (which can be stale in either
    // direction: false when the account is actually ready, just as easily
    // as true when Stripe has since restricted it).
    const agentStripeAccount = (task.agents as any)?.stripe_account_id
    const agentOnboardingDone = (task.agents as any)?.stripe_onboarding_completed
    if (!agentStripeAccount) {
      return NextResponse.json({
        error: 'Agent has not started Stripe Connect onboarding. Payment cannot be created until the agent links their payout account.',
        stripe_onboarding_required: true,
      }, { status: 402 })
    }

    // Check whether the agent still has a fee-free introductory task.
    const agentFreeTasksRemaining = (task.agents as any)?.free_tasks_remaining ?? 0
    const isFreeTask = agentFreeTasksRemaining > 0

    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
    }

    const StripeCtor = (await import('stripe')).default
    const stripe = new StripeCtor(process.env.STRIPE_SECRET_KEY)

    // Fail-closed country gate — checked, and enforced, BEFORE
    // claim_task_payment ever runs, so a disallowed country produces ZERO
    // database writes: no 'pending' transaction row, no frozen
    // payment_method that could make a later retry (even with a different
    // payment_method) collide into a 409. Only a brand-new attempt is
    // gated — an existing transaction already carrying a real PaymentIntent
    // for this task (this mirrors claim_task_payment's own lookup: the most
    // recent transaction in 'pending'/'held'/'released') is a resume, and
    // resumes are never re-evaluated; old destination-charge rows included.
    //
    // isPaymentCountryEnabled is the intersection of BOTH allowlists —
    // checking STRIPE_DIRECT_CHARGE_COUNTRIES alone would let a country
    // removed from (or never added to) STRIPE_CONNECT_ENABLED_COUNTRIES
    // still accept live payments. See stripeConnectCountries.ts.
    const { data: existingTxForGate, error: existingTxForGateError } = await db
      .from('transactions')
      .select('stripe_payment_intent_id')
      .eq('task_id', task_id)
      .in('escrow_status', ['pending', 'held', 'released'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existingTxForGateError) throw existingTxForGateError
    const isNewChargeAttempt = !existingTxForGate?.stripe_payment_intent_id?.startsWith('pi_')

    let accountForGate: Stripe.Account | null = null
    if (isNewChargeAttempt) {
      accountForGate = await stripe.accounts.retrieve(agentStripeAccount)
      const gateCountryCode = typeof accountForGate.country === 'string' ? accountForGate.country.toUpperCase() : undefined
      if (!gateCountryCode || !isPaymentCountryEnabled(gateCountryCode)) {
        return NextResponse.json({
          error: gateCountryCode
            ? `Direct Charge payments are not yet enabled for ${gateCountryCode}. Contact support.`
            : 'Could not determine the connected account\'s country — payment cannot be created.',
          direct_charge_country_enabled: false,
        }, { status: 403 })
      }
    }

    // Freeze the financial terms in one transaction row before talking to
    // Stripe. The database task lock + partial unique index make concurrent
    // requests converge on this same claim; payment_attempt_key then serves
    // as Stripe's stable idempotency key.
    const calculatedFees = calculateFees(gross_amount_eur, await getPlatformFeePercent())
    if (isFreeTask) {
      calculatedFees.platform_fee_eur = 0
      calculatedFees.agent_payout_eur = Math.round((gross_amount_eur - calculatedFees.stripe_fee_eur) * 100) / 100
    }
    const sum = calculatedFees.stripe_fee_eur + calculatedFees.platform_fee_eur + calculatedFees.agent_payout_eur
    if (Math.abs(sum - gross_amount_eur) > 0.02) {
      return NextResponse.json({ error: 'Fee calculation error' }, { status: 500 })
    }

    const { data: claimData, error: claimError } = await db.rpc('claim_task_payment', {
      p_task_id: task_id,
      p_buyer_org_id: resolvedBuyerOrgId,
      p_agent_id: task.assigned_agent_id,
      p_accepted_bid_id: acceptedBid.id,
      p_payment_method: paymentMethod,
      p_gross_amount_eur: gross_amount_eur,
      p_platform_fee_eur: calculatedFees.platform_fee_eur,
      p_processing_deduction_eur: calculatedFees.stripe_fee_eur,
      p_agent_payout_eur: calculatedFees.agent_payout_eur,
    })
    if (claimError) {
      if (claimError.code === 'P0001' || claimError.code === '23505') {
        return NextResponse.json({ error: 'Payment cannot be created for the current task, bid, or payment state' }, { status: 409 })
      }
      if (claimError.code === 'P0002') return NextResponse.json({ error: 'Task or accepted bid not found' }, { status: 404 })
      return NextResponse.json({ error: 'Payment claim could not be recorded' }, { status: 500 })
    }
    const paymentTx = Array.isArray(claimData) ? claimData[0] : claimData
    if (!paymentTx?.transaction_id || !paymentTx.payment_attempt_key) {
      return NextResponse.json({ error: 'Payment claim was not confirmed' }, { status: 500 })
    }

    // Read the durable namespace after claiming the transaction. Existing
    // PaymentIntents must finish in the namespace where they were created;
    // only a brand-new attempt is bound to the Direct Charge model. This is
    // required for a safe rolling deploy from destination charges.
    const { data: claimedTx, error: claimedTxError } = await db
      .from('transactions')
      .select('id,stripe_payment_intent_id,stripe_charge_model,stripe_connected_account_id')
      .eq('id', paymentTx.transaction_id)
      .maybeSingle()
    if (claimedTxError) throw claimedTxError
    if (!claimedTx) throw new Error('Claimed payment transaction could not be reloaded')

    const existingPaymentIntentId = claimedTx.stripe_payment_intent_id ?? paymentTx.stripe_payment_intent_id
    // Must agree with the pre-claim gate's own determination — it does,
    // barring a concurrent claim on the same task racing in between (see
    // claim_task_payment's row locking), in which case this transaction is
    // simply whichever one won that race, and this call correctly defers
    // to it as an existing attempt rather than starting a second one.
    if (Boolean(existingPaymentIntentId?.startsWith('pi_')) === isNewChargeAttempt) {
      throw new Error('Payment claim state disagreed with the pre-claim country-gate check')
    }

    const paymentContext = isNewChargeAttempt
      ? await bindDirectChargeContext(db, paymentTx.transaction_id, agentStripeAccount)
      : paymentContextFromTransaction(claimedTx)

    if (paymentContext.chargeModel === 'direct' && paymentContext.connectedAccountId !== agentStripeAccount) {
      return NextResponse.json({
        error: 'This payment attempt is tied to a different Stripe account. Contact support before retrying it.',
      }, { status: 409 })
    }

    // Re-verify the capability before returning a usable client_secret or
    // creating a PaymentIntent. For Direct Charges this is the immutable
    // connected-account namespace stored on the transaction; legacy
    // destination rows continue to use the assigned agent's account.
    // Reuses the account already fetched for the gate check above when it
    // is the same account (always true for a brand-new attempt — the
    // account-mismatch case above already returned) rather than a second,
    // redundant Stripe API call.
    const readinessAccountId = paymentContext.connectedAccountId ?? agentStripeAccount
    const accountForReadiness = accountForGate && readinessAccountId === agentStripeAccount
      ? accountForGate
      : await stripe.accounts.retrieve(readinessAccountId)
    const connectedCountry = typeof accountForReadiness.country === 'string'
      ? getOnboardingCountry(accountForReadiness.country.toUpperCase())
      : undefined
    if (paymentMethod === 'sepa_debit' && connectedCountry && !connectedCountry.supportsSepaDebit) {
      return NextResponse.json({
        error: `SEPA Direct Debit is not available for the agent's ${connectedCountry.label} payout account. Use card payment instead.`,
        payment_method_unavailable: true,
        supported_payment_methods: ['card'],
      }, { status: 400 })
    }
    const readiness = computeStripeAccountReadiness(accountForReadiness)
    await syncOnboardingCompletedFlag(db, (task.agents as any)?.id, agentOnboardingDone, readiness.onboardingComplete)
    if (!isMethodReady(readiness, paymentMethod)) {
      return NextResponse.json({
        error: `Agent's Stripe account is not currently ready to accept ${paymentMethod === 'card' ? 'card' : 'SEPA Direct Debit'} payments.`,
        stripe_onboarding_required: true,
        payout_ready: readiness.payoutReady,
        card_ready: readiness.cardReady,
        sepa_debit_ready: readiness.sepaDebitReady,
      }, { status: 402 })
    }

    if (existingPaymentIntentId?.startsWith('pi_')) {
      const existingIntent = await stripe.paymentIntents.retrieve(
        existingPaymentIntentId,
        stripeRequestOptions(paymentContext),
      )
      const existingMethod = existingIntent.payment_method_types[0]
      const canReuse = existingMethod === paymentMethod && existingIntent.status !== 'canceled'

      if (canReuse && existingIntent.client_secret) {
        const paymentState = await reconcilePaymentIntent(existingIntent, undefined, stripe)
        if (paymentState === 'authorized') {
          return NextResponse.json({ error: 'Payment is already funded', transaction_id: paymentTx.transaction_id }, { status: 409 })
        }
        return NextResponse.json({
          transaction_id: paymentTx.transaction_id,
          client_secret: existingIntent.client_secret,
          gross_amount_eur: Number(paymentTx.gross_amount_eur),
          platform_fee_eur: Number(paymentTx.platform_fee_eur),
          // stripe_fee_eur is a deprecated alias — see payment_processing_deduction_eur.
          stripe_fee_eur: Number(paymentTx.processing_deduction_eur),
          payment_processing_deduction_eur: Number(paymentTx.processing_deduction_eur),
          agent_payout_eur: Number(paymentTx.agent_payout_eur),
          free_task: Number(paymentTx.platform_fee_eur) === 0,
          free_tasks_remaining_after: agentFreeTasksRemaining,
          review_deadline_at: null,
          capture_mode: existingIntent.capture_method === 'manual' ? 'manual' : 'immediate',
          payment_method: existingMethod,
          stripe_connected_account_id: paymentContext.connectedAccountId,
          charge_model: paymentContext.chargeModel,
        })
      }

      if (existingIntent.status === 'canceled') {
        await reconcilePaymentIntent(existingIntent, undefined, stripe)
        return NextResponse.json({ error: 'Previous payment was canceled. Retry to create a new payment attempt.' }, { status: 409 })
      }
      return NextResponse.json({ error: `Existing payment is ${existingIntent.status}; it cannot be replaced` }, { status: 409 })
    }

    const frozenGross = Number(paymentTx.gross_amount_eur)
    const frozenPlatformFee = Number(paymentTx.platform_fee_eur)
    const frozenProcessingDeduction = Number(paymentTx.processing_deduction_eur)
    const frozenAgentPayout = Number(paymentTx.agent_payout_eur)
    if (![frozenGross, frozenPlatformFee, frozenProcessingDeduction, frozenAgentPayout].every(Number.isFinite)) {
      throw new Error('Frozen payment amounts are invalid')
    }
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(frozenGross * 100),
      currency: 'eur',
      payment_method_types: [paymentMethod],
      ...(captureMode === 'manual' ? { capture_method: 'manual' as const } : {}),
      // Direct Charge: the PaymentIntent/Charge is created in the agent's
      // connected-account namespace. Gross funds never settle into
      // Mercatai's platform balance; Stripe sends only this application fee
      // to Mercatai. This also avoids the cross-border on_behalf_of limitation
      // of the previous destination-charge architecture.
      application_fee_amount: Math.round((frozenPlatformFee + frozenProcessingDeduction) * 100),
      metadata: {
        task_id,
        buyer_org_id: resolvedBuyerOrgId,
        agent_id: task.assigned_agent_id,
        platform: 'mercatai',
        free_task: isFreeTask ? 'true' : 'false',
        capture_mode: captureMode,
        charge_model: 'direct',
      },
    }, directChargeCreateOptions(agentStripeAccount, `mercatai-payment-${paymentTx.payment_attempt_key}`))
    if (!intent.client_secret) throw new Error('Stripe returned no client_secret')

    const { data: bound, error: bindError } = await db
      .from('transactions')
      .update({ stripe_payment_intent_id: intent.id })
      .eq('id', paymentTx.transaction_id)
      .eq('escrow_status', 'pending')
      .is('stripe_payment_intent_id', null)
      .select('id')
      .maybeSingle()
    if (bindError) throw bindError
    if (!bound) {
      const { data: current, error: currentError } = await db.from('transactions')
        .select('stripe_payment_intent_id,escrow_status')
        .eq('id', paymentTx.transaction_id)
        .maybeSingle()
      if (currentError) throw currentError
      if (current?.stripe_payment_intent_id !== intent.id || current.escrow_status !== 'pending') {
        throw new Error('Stripe PaymentIntent binding was not confirmed')
      }
    }

    if (bound) {
      await auditLog({
        action: 'payment_intent_created',
        resource_type: 'transaction',
        resource_id: paymentTx.transaction_id,
        details: {
          task_id,
          gross_amount_eur: frozenGross,
          platform_fee_eur: frozenPlatformFee,
          payment_processing_deduction_eur: frozenProcessingDeduction,
          agent_payout_eur: frozenAgentPayout,
          free_task: frozenPlatformFee === 0,
          stripe_id: intent.id,
        },
        ip_address: request.headers.get('x-forwarded-for') ?? undefined,
      })
    }

    return NextResponse.json({
      transaction_id: paymentTx.transaction_id,
      client_secret: intent.client_secret,
      gross_amount_eur: frozenGross,
      platform_fee_eur: frozenPlatformFee,
      stripe_fee_eur: frozenProcessingDeduction,
      agent_payout_eur: frozenAgentPayout,
      // stripe_fee_eur (in ...fees above) is a deprecated alias — it is
      // Mercatai's own payment-processing deduction, not a Stripe invoice.
      // payment_processing_deduction_eur is the canonical public field.
      payment_processing_deduction_eur: frozenProcessingDeduction,
      free_task: frozenPlatformFee === 0,
      free_tasks_remaining_after: frozenPlatformFee === 0 ? agentFreeTasksRemaining - 1 : agentFreeTasksRemaining,
      review_deadline_at: null,
      capture_mode: captureMode,
      payment_method: paymentMethod,
      stripe_connected_account_id: agentStripeAccount,
      charge_model: 'direct',
    }, { status: paymentTx.created ? 201 : 200 })

  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Payment creation failed' }, { status: 500 })
  }
}
