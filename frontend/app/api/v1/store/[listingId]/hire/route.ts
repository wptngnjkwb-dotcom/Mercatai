import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { getSupabase } from '@/lib/server/supabase'
import { signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { sendBidAcceptedActionRequired, sendTaskCreated } from '@/lib/server/email'
import { moderateTask } from '@/lib/server/taskModeration/moderateTask'
import { STANDARD_AGENT_LIABILITY, publicPaymentResponsibility, stripeAccountFields } from '@/lib/server/stripeAccountRequirement'
import { getLiveAgentPaymentSetup, paymentSetupRequiredBody, PaymentSetupLookupError } from '@/lib/server/agentPaymentSetup'
import { clientIp, isRateLimited, recordAttempt } from '@/lib/server/rateLimit'

/**
 * Instant hire — the second entry point into the marketplace.
 *
 * Instead of posting an open task and waiting for bids, the buyer picks a
 * productized service from the Agent Store. This creates a task already
 * assigned to the listing's agent (with an accepted bid at the listed
 * price), and returns the buyer token. Payment then flows through the
 * standard protected-payment pipeline (create-intent → in_progress →
 * deliver → approve), so payment confirmation, objective SLA refunds,
 * facilitated quality issues, and audit all work unchanged.
 */
export async function POST(request: NextRequest, { params }: { params: { listingId: string } }) {
  try {
    // Fail fast on config errors, before creating any task/bid — signToken
    // needs the task id so it can only run after those writes, and we don't
    // want a misconfigured secret to leave an orphaned assigned task behind.
    if (!process.env.JWT_SECRET_KEY) {
      throw new Error('JWT_SECRET_KEY environment variable is not set')
    }

    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) {
      return NextResponse.json({
        error: 'Idempotency-Key header is required (16-200 letters, numbers, dot, underscore, colon or hyphen)',
      }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const { details, org_name, buyer_email } = body
    if (details !== undefined && (typeof details !== 'string' || details.trim().length > 50000)) {
      return NextResponse.json({ error: 'details must be text up to 50,000 characters' }, { status: 400 })
    }
    if (org_name !== undefined && (typeof org_name !== 'string' || org_name.trim().length > 200)) {
      return NextResponse.json({ error: 'org_name must be text up to 200 characters' }, { status: 400 })
    }
    const normalizedBuyerEmail = typeof buyer_email === 'string' ? buyer_email.trim().toLowerCase() : ''
    if (!normalizedBuyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedBuyerEmail)) {
      return NextResponse.json({ error: 'buyer_email is required and must be valid — it is needed to deliver and restore buyer access.' }, { status: 400 })
    }

    const db = getSupabase()

    const normalizedOrgName = typeof org_name === 'string' ? org_name.trim() : 'anonymous'
    const normalizedDetails = typeof details === 'string' ? details.trim() : null
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      listing_id: params.listingId,
      buyer_email: normalizedBuyerEmail,
      org_name: normalizedOrgName || 'anonymous',
      details: normalizedDetails || '',
    })).digest('hex')

    // A successful response may have been lost after the transaction
    // committed. Replays must return that original task even if the listing
    // was subsequently paused or Stripe is temporarily unavailable. The
    // RPC remains the canonical fingerprint/ownership check; this lookup
    // only chooses the safe replay path before any external side effect.
    const { data: existingHire, error: existingHireError } = await db
      .from('store_hire_requests')
      .select('task_id,request_fingerprint')
      .eq('listing_id', params.listingId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()
    if (existingHireError) throw existingHireError
    if (existingHire) {
      if (existingHire.request_fingerprint !== requestFingerprint) {
        return NextResponse.json({ error: 'Idempotency-Key was already used for a different request' }, { status: 409 })
      }
      const { data: existingTask, error: existingTaskError } = await db
        .from('tasks')
        .select('assigned_agent_id')
        .eq('id', existingHire.task_id)
        .single()
      if (existingTaskError || !existingTask?.assigned_agent_id) {
        throw existingTaskError || new Error('Stored hire task is unavailable')
      }
      const { data: replayData, error: replayError } = await db.rpc('create_store_hire', {
        p_listing_id: params.listingId,
        p_expected_agent_id: existingTask.assigned_agent_id,
        p_org_name: normalizedOrgName,
        p_buyer_email: normalizedBuyerEmail,
        p_buyer_details: normalizedDetails,
        p_moderation_risk_score: 0,
        p_moderation_reason_codes: [],
        p_moderation_policy_version: 'idempotent-replay',
        p_idempotency_key: idempotencyKey,
        p_request_fingerprint: requestFingerprint,
      })
      if (replayError) {
        if (replayError.code === 'P0003') {
          return NextResponse.json({ error: 'Idempotency-Key was already used for a different request' }, { status: 409 })
        }
        throw replayError
      }
      const replay = Array.isArray(replayData) ? replayData[0] : replayData
      if (!replay?.task_id || !replay?.buyer_org_id) throw new Error('Instant hire replay was not confirmed')
      const replayBuyerToken = await signToken({
        role: 'buyer', task_id: replay.task_id, org_id: replay.buyer_org_id, buyer_email: normalizedBuyerEmail,
      }, '30d')
      return NextResponse.json({
        task_id: replay.task_id,
        buyer_org_id: replay.buyer_org_id,
        agent: replay.agent_display_name,
        price_eur: Number(replay.price_eur),
        delivery_deadline_at: null,
        ...publicPaymentResponsibility(STANDARD_AGENT_LIABILITY),
        buyer_token: replayBuyerToken,
        buyer_token_note: 'Save this token — required to fund, review, approve, or open a facilitated quality issue for this task',
        idempotent_replay: true,
        visibility: 'private',
        source: 'store',
        next_step: 'POST /api/v1/payments/create-intent with this buyer_token to fund the task',
      }, { status: 200 })
    }

    // Anonymous Store hires can create assigned-but-unfunded work and send
    // transactional email. Bound only NEW attempts per caller. A byte-for-
    // byte idempotent replay above is a read/recovery operation with no new
    // task or email side effect, so it must not consume the creation quota
    // or become unavailable merely because the caller retried a lost reply.
    const ip = clientIp(request)
    if (await isRateLimited({ action: 'store_hire_attempt', ip, windowMinutes: 60, maxEvents: 5 })) {
      return NextResponse.json(
        { error: 'Too many Store hire attempts — try again later', code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '3600' } },
      )
    }
    await recordAttempt('store_hire_attempt', ip, { listing_id: params.listingId })

    const { data: listing } = await db
      .from('agent_listings')
      .select('*, agents!inner(id,display_name,is_active,profile_visibility,owner_email,stripe_standard_account_id,stripe_standard_onboarding_completed)')
      .eq('id', params.listingId)
      .eq('is_active', true)
      .eq('status', 'active')
      .eq('moderation_status', 'approved')
      .single()

    // A private agent's listing must be just as unreachable by a known
    // listingId as it already is from the GET /store list — otherwise
    // hiding it from the list is a UI-only fig leaf, not a real boundary.
    if (!listing || !(listing.agents as any)?.is_active || (listing.agents as any)?.profile_visibility !== 'public') {
      return NextResponse.json({ error: 'Listing not found or inactive' }, { status: 404 })
    }

    // Check before moderation, organization creation, task creation or bid
    // creation. A Store listing may remain visible while its provider fixes
    // Stripe, but a buyer can never create an assigned, unpayable hire.
    try {
      const setup = await getLiveAgentPaymentSetup({
        db,
        agent: listing.agents as any,
        requirement: STANDARD_AGENT_LIABILITY,
      })
      if (!setup.ready) {
        return NextResponse.json(paymentSetupRequiredBody(setup, false), { status: 402 })
      }
    } catch (error) {
      if (error instanceof PaymentSetupLookupError) {
        return NextResponse.json({ error: 'Provider payment setup could not be verified right now', code: 'payment_setup_unavailable' }, { status: 503 })
      }
      throw error
    }

    // Trust & Safety: moderate the listing's own content before creating
    // anything. Instant-hire has no "buyer waits for review" step, so unlike
    // POST /tasks this doesn't persist a quarantined/pending task — it just
    // blocks outright. No org, task, or bid is created for a blocked hire.
    const moderation = await moderateTask({
      title: listing.title,
      description: details ? `${listing.description}\n\n--- Buyer brief ---\n${details}` : listing.description,
      budgetMinEur: listing.price_eur,
      budgetMaxEur: listing.price_eur,
      category: listing.category || 'research',
    })
    if (moderation.decision !== 'allow' && moderation.decision !== 'allow_with_warning') {
      await auditLog({
        action: 'instant_hire_blocked',
        resource_type: 'agent_listing',
        resource_id: listing.id,
        agent_id: listing.agent_id,
        details: { decision: moderation.decision, reason_codes: moderation.reasonCodes, risk_score: moderation.riskScore },
        ip_address: request.headers.get('x-forwarded-for') ?? undefined,
      })
      return NextResponse.json({
        error: 'This listing cannot be instant-hired right now',
        reason_codes: moderation.reasonCodes,
        explanation: moderation.publicExplanation,
        policy_url: 'https://mercatai.eu/safety',
      }, { status: moderation.decision === 'quarantine' ? 202 : 422 })
    }

    // Organization + assigned task + accepted bid + listing counter are one
    // transaction. A downstream payment can never see a half-created hire.
    const { data: hireData, error: hireError } = await db.rpc('create_store_hire', {
      p_listing_id: listing.id,
      p_expected_agent_id: listing.agent_id,
      p_org_name: normalizedOrgName,
      p_buyer_email: normalizedBuyerEmail,
      p_buyer_details: normalizedDetails,
      p_moderation_risk_score: moderation.riskScore,
      p_moderation_reason_codes: moderation.reasonCodes,
      p_moderation_policy_version: moderation.policyVersion,
      p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
    })
    if (hireError) {
      if (hireError.code === 'P0001') return NextResponse.json({ error: 'Listing can no longer be hired' }, { status: 409 })
      if (hireError.code === 'P0002') return NextResponse.json({ error: 'Listing not found or inactive' }, { status: 404 })
      if (hireError.code === 'P0003') return NextResponse.json({ error: 'Idempotency-Key was already used for a different request' }, { status: 409 })
      throw hireError
    }
    const task = Array.isArray(hireData) ? hireData[0] : hireData
    if (!task?.task_id || !task?.buyer_org_id) throw new Error('Instant hire was not confirmed')
    const orgId: string = task.buyer_org_id

    const buyerToken = await signToken(
      { role: 'buyer', task_id: task.task_id, org_id: orgId, ...(normalizedBuyerEmail ? { buyer_email: normalizedBuyerEmail } : {}) },
      '30d'
    )

    const createdNew = task.created_new !== false
    if (createdNew) {
      const listingAgent = listing.agents as any
      if (listingAgent?.owner_email) {
        const fields = stripeAccountFields(STANDARD_AGENT_LIABILITY)
        await sendBidAcceptedActionRequired({
          to: listingAgent.owner_email,
          taskTitle: task.task_title,
          taskId: task.task_id,
          agentId: listing.agent_id,
          priceEur: Number(listing.price_eur),
          deliveryHours: Number(listing.delivery_hours),
          stripeAccountType: fields.stripeType,
          onboardingRequired: !listingAgent[fields.accountId] || listingAgent[fields.onboardingCompleted] !== true,
        })
      }

      await sendTaskCreated({
          to: normalizedBuyerEmail,
          taskTitle: task.task_title,
          taskId: task.task_id,
          buyerToken,
          budgetMax: listing.price_eur,
          kind: 'store_hire',
          assignedAgentName: task.agent_display_name,
        })
    }

    return NextResponse.json({
      task_id: task.task_id,
      buyer_org_id: orgId,
      agent: task.agent_display_name,
      price_eur: listing.price_eur,
      delivery_deadline_at: null,
      ...publicPaymentResponsibility(STANDARD_AGENT_LIABILITY),
      buyer_token: buyerToken,
      buyer_token_note: 'Save this token — required to fund, review, approve, or open a facilitated quality issue for this task',
      idempotent_replay: !createdNew,
      visibility: 'private',
      source: 'store',
      next_step: 'POST /api/v1/payments/create-intent with this buyer_token to fund the task',
    }, { status: createdNew ? 201 : 200 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Instant hire failed' }, { status: 500 })
  }
}
