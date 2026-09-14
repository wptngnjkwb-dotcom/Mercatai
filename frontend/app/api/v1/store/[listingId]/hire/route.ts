import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { sendTaskCreated } from '@/lib/server/email'
import { moderateTask } from '@/lib/server/taskModeration/moderateTask'
import { agentIdentityForWebhook } from '@/lib/server/agentVisibility'

/**
 * Instant hire — the second entry point into the marketplace.
 *
 * Instead of posting an open task and waiting for bids, the buyer picks a
 * productized service from the Agent Store. This creates a task already
 * assigned to the listing's agent (with an accepted bid at the listed
 * price), and returns the buyer token. Payment then flows through the
 * standard pay-on-approval pipeline (create-intent → in_progress →
 * deliver → approve), so escrow, SLA refunds, disputes, and audit all
 * work unchanged.
 */
export async function POST(request: NextRequest, { params }: { params: { listingId: string } }) {
  try {
    // Fail fast on config errors, before creating any task/bid — signToken
    // needs the task id so it can only run after those writes, and we don't
    // want a misconfigured secret to leave an orphaned assigned task behind.
    if (!process.env.JWT_SECRET_KEY) {
      throw new Error('JWT_SECRET_KEY environment variable is not set')
    }

    const body = await request.json().catch(() => ({}))
    const { details, org_name, buyer_email } = body
    if (details !== undefined && (typeof details !== 'string' || details.trim().length > 50000)) {
      return NextResponse.json({ error: 'details must be text up to 50,000 characters' }, { status: 400 })
    }
    if (org_name !== undefined && (typeof org_name !== 'string' || org_name.trim().length > 200)) {
      return NextResponse.json({ error: 'org_name must be text up to 200 characters' }, { status: 400 })
    }
    const normalizedBuyerEmail = typeof buyer_email === 'string' ? buyer_email.trim().toLowerCase() : null
    if (buyer_email !== undefined && (!normalizedBuyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedBuyerEmail))) {
      return NextResponse.json({ error: 'buyer_email must be a valid email address' }, { status: 400 })
    }

    const db = getSupabase()

    const { data: listing } = await db
      .from('agent_listings')
      .select('*, agents!inner(id,display_name,is_active,profile_visibility)')
      .eq('id', params.listingId)
      .eq('is_active', true)
      .single()

    // A private agent's listing must be just as unreachable by a known
    // listingId as it already is from the GET /store list — otherwise
    // hiding it from the list is a UI-only fig leaf, not a real boundary.
    if (!listing || !(listing.agents as any)?.is_active || (listing.agents as any)?.profile_visibility !== 'public') {
      return NextResponse.json({ error: 'Listing not found or inactive' }, { status: 404 })
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
      p_org_name: typeof org_name === 'string' ? org_name.trim() : 'anonymous',
      p_buyer_email: normalizedBuyerEmail,
      p_buyer_details: typeof details === 'string' ? details.trim() : null,
      p_moderation_risk_score: moderation.riskScore,
      p_moderation_reason_codes: moderation.reasonCodes,
      p_moderation_policy_version: moderation.policyVersion,
    })
    if (hireError) {
      if (hireError.code === 'P0001') return NextResponse.json({ error: 'Listing can no longer be hired' }, { status: 409 })
      if (hireError.code === 'P0002') return NextResponse.json({ error: 'Listing not found or inactive' }, { status: 404 })
      throw hireError
    }
    const task = Array.isArray(hireData) ? hireData[0] : hireData
    if (!task?.task_id || !task?.buyer_org_id) throw new Error('Instant hire was not confirmed')
    const orgId: string = task.buyer_org_id

    const buyerToken = await signToken(
      { role: 'buyer', task_id: task.task_id, org_id: orgId, ...(normalizedBuyerEmail ? { buyer_email: normalizedBuyerEmail } : {}) },
      '30d'
    )

    await auditLog({
      action: 'instant_hire',
      resource_type: 'task',
      resource_id: task.task_id,
      agent_id: listing.agent_id,
      details: { listing_id: listing.id, price_eur: listing.price_eur },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })
    fireWebhooks('bid.accepted', {
      task_id: task.task_id,
      ...(await agentIdentityForWebhook(db, listing.agent_id)),
      price_eur: listing.price_eur,
    })

    if (normalizedBuyerEmail) {
      sendTaskCreated({
        to: normalizedBuyerEmail,
        taskTitle: task.task_title,
        taskId: task.task_id,
        buyerToken,
        budgetMax: listing.price_eur,
      }).catch(console.error)
    }

    return NextResponse.json({
      task_id: task.task_id,
      buyer_org_id: orgId,
      agent: task.agent_display_name,
      price_eur: listing.price_eur,
      delivery_deadline_at: null,
      buyer_token: buyerToken,
      buyer_token_note: 'Save this token — required to pay, approve, or dispute this task',
      next_step: 'POST /api/v1/payments/create-intent with this buyer_token to fund the task',
    }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Instant hire failed' }, { status: 500 })
  }
}
