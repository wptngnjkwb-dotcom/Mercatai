import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { signToken, getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { fireWebhooks } from '@/lib/server/webhooks'
import { sendTaskCreated } from '@/lib/server/email'
import { moderateTask } from '@/lib/server/taskModeration/moderateTask'

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

    const db = getSupabase()

    const { data: listing } = await db
      .from('agent_listings')
      .select('*, agents!inner(id,display_name,is_active)')
      .eq('id', params.listingId)
      .eq('is_active', true)
      .single()

    if (!listing || !(listing.agents as any)?.is_active) {
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

    // Buyer organization — same identity rule as POST /tasks: org_name is
    // a free-text display label, never an identity lookup key. Reusing an
    // existing organization requires that org's own buyer_token; every
    // other caller gets a brand new organization row, even on a name
    // collision (see the comment in POST /tasks for why).
    const orgName = org_name || 'anonymous'
    const callerToken = await getTokenFromRequest(request)
    const returningBuyerOrgId = callerToken?.role === 'buyer' && typeof callerToken.org_id === 'string' ? callerToken.org_id : null

    let orgId: string
    if (returningBuyerOrgId) {
      const { data: existingOrg } = await db.from('organizations').select('id, is_suspended').eq('id', returningBuyerOrgId).maybeSingle()
      if (!existingOrg) {
        return NextResponse.json({ error: 'Invalid buyer token — organization not found' }, { status: 400 })
      }
      if (existingOrg.is_suspended) {
        return NextResponse.json({ error: 'This organization has been suspended and cannot instant-hire' }, { status: 403 })
      }
      orgId = existingOrg.id
    } else {
      const { data: newOrg, error: orgErr } = await db
        .from('organizations')
        .insert({ name: orgName, verification_level: 'anonymous' })
        .select('id')
        .single()
      if (orgErr) throw orgErr
      orgId = newOrg.id
    }

    const assignedAt = new Date()
    const deadline = new Date(assignedAt.getTime() + listing.delivery_hours * 60 * 60 * 1000)

    // Task is born assigned — no bidding window
    const taskInsert = {
      posted_by_org_id: orgId,
      title: listing.title,
      description: details
        ? `${listing.description}\n\n--- Buyer brief ---\n${details}`
        : listing.description,
      category: listing.category || 'research',
      budget_min_eur: listing.price_eur,
      budget_max_eur: listing.price_eur,
      deadline_hours: listing.delivery_hours,
      status: 'assigned',
      assigned_agent_id: listing.agent_id,
      ...(buyer_email ? { buyer_email } : {}),
      // Already passed the moderation gate above (the only decisions that
      // reach this line are allow/allow_with_warning) — persist that, or
      // the row defaults to moderation_status='pending' and every other
      // endpoint hides a task this one just told the buyer was live.
      moderation_status: 'approved',
      moderation_risk_score: moderation.riskScore,
      moderation_reason_codes: moderation.reasonCodes,
      moderation_policy_version: moderation.policyVersion,
      moderated_at: new Date().toISOString(),
      moderated_by: 'system:auto',
      published_at: new Date().toISOString(),
    }

    let task: any
    {
      // SLA columns may not be migrated everywhere — mirror the fallback in bid accept
      const { data, error } = await db
        .from('tasks')
        .insert({ ...taskInsert, assigned_at: assignedAt.toISOString(), delivery_deadline_at: deadline.toISOString() })
        .select()
        .single()
      if (error) {
        const { data: retry, error: retryErr } = await db.from('tasks').insert(taskInsert).select().single()
        if (retryErr) throw retryErr
        task = retry
      } else {
        task = data
      }
    }

    // Record the transaction shape downstream code expects: an accepted bid
    await db.from('bids').insert({
      task_id: task.id,
      agent_id: listing.agent_id,
      price_eur: listing.price_eur,
      delivery_hours: listing.delivery_hours,
      approach_summary: `Instant hire via Agent Store listing "${listing.title}"`,
      score: 1,
      status: 'accepted',
    })

    await db
      .from('agent_listings')
      .update({ hires_count: (listing.hires_count ?? 0) + 1 })
      .eq('id', listing.id)

    const buyerToken = await signToken(
      { role: 'buyer', task_id: task.id, org_id: orgId, ...(buyer_email ? { buyer_email } : {}) },
      '30d'
    )

    await auditLog({
      action: 'instant_hire',
      resource_type: 'task',
      resource_id: task.id,
      agent_id: listing.agent_id,
      details: { listing_id: listing.id, price_eur: listing.price_eur },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })
    fireWebhooks('bid.accepted', { task_id: task.id, agent_id: listing.agent_id, price_eur: listing.price_eur })

    if (buyer_email && typeof buyer_email === 'string' && buyer_email.includes('@')) {
      sendTaskCreated({
        to: buyer_email,
        taskTitle: task.title,
        taskId: task.id,
        buyerToken,
        budgetMax: listing.price_eur,
      }).catch(console.error)
    }

    return NextResponse.json({
      task_id: task.id,
      buyer_org_id: orgId,
      agent: (listing.agents as any).display_name,
      price_eur: listing.price_eur,
      delivery_deadline_at: deadline.toISOString(),
      buyer_token: buyerToken,
      buyer_token_note: 'Save this token — required to pay, approve, or dispute this task',
      next_step: 'POST /api/v1/payments/create-intent with this buyer_token to fund the task',
    }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Instant hire failed' }, { status: 500 })
  }
}
