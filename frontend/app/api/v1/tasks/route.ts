import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { signToken } from '@/lib/server/auth'
import { fireWebhooks } from '@/lib/server/webhooks'
import { resolveApiClient } from '@/lib/server/affiliate'
import { checkQuota, trackApiCall } from '@/lib/server/apiUsage'
import { sendTaskCreated } from '@/lib/server/email'
import { runAutoBids } from '@/lib/server/autobid'
import { moderateTask } from '@/lib/server/taskModeration/moderateTask'
import { isRateLimited, clientIp } from '@/lib/server/rateLimit'
import { recordModerationEvent } from '@/lib/server/taskModeration/audit'
import { attachPublicTaskFields } from '@/lib/server/publicTaskFields'
import { MAX_TRANSACTION_EUR } from '@/lib/server/settings'

// Run in Supabase:
// ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

export async function GET(request: NextRequest) {
  try {
    // Metered billing: track + enforce quota for authenticated API clients
    const apiClient = await resolveApiClient(request.headers.get('authorization'))
    if (apiClient) {
      const quota = await checkQuota(apiClient.id, apiClient.plan)
      if (!quota.allowed) {
        return NextResponse.json({
          error: `Monthly API quota exceeded (${quota.used}/${quota.limit} calls on ${quota.plan} plan). Upgrade at https://mercatai.eu/developer`,
          quota,
        }, { status: 429 })
      }
      trackApiCall(apiClient.id)
    }

    const db = getSupabase()
    const { searchParams } = new URL(request.url)
    const explicitStatus = searchParams.get('status')
    const category = searchParams.get('category')
    const limit = Math.min(Number(searchParams.get('limit') || 20), 100)

    // Exclude embedding (vector field) from public response
    let query = db.from('tasks').select('id,title,description,category,status,budget_min_eur,budget_max_eur,deadline_hours,required_capabilities,required_languages,posted_by_org_id,assigned_agent_id,bidding_closes_at,created_at')
      // Trust & Safety: only ever surface moderated-and-approved tasks
      // publicly, independent of the workflow status filtering below.
      .eq('moderation_status', 'approved')
    // Default to both biddable states — a task moves from 'open' to
    // 'bidding' on its first bid, and dropping out of the default listing
    // right when competing bids become possible restricts exactly the
    // liquidity an open marketplace depends on. Explicit ?status= still
    // filters to one state, e.g. for buyers checking 'completed' work.
    query = explicitStatus ? query.eq('status', explicitStatus) : query.in('status', ['open', 'bidding'])
    if (category) query = query.eq('category', category)

    const { data, error } = await query.order('created_at', { ascending: false }).limit(limit)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const tasks = await attachPublicTaskFields(db, data ?? [])
    return NextResponse.json({ tasks })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    // Rate limiting: 5 tasks per IP per hour. Database-backed (counts
    // recent 'task_created' audit_logs rows for this IP) — an in-memory
    // Map does not work across serverless instances, which don't share
    // memory and each start with an empty one.
    const ip = clientIp(request)
    if (await isRateLimited({ action: 'task_created', ip, windowMinutes: 60, maxEvents: 5 })) {
      return NextResponse.json({ error: 'Rate limit exceeded — max 5 tasks per hour per IP' }, { status: 429 })
    }

    const body = await request.json()
    const {
      title, description, category, required_capabilities, required_languages,
      budget_min_eur, budget_max_eur, deadline_hours, org_name, buyer_email,
    } = body

    if (!title || !description || !budget_max_eur || !deadline_hours) {
      return NextResponse.json({ error: 'title, description, budget_max_eur and deadline_hours are required' }, { status: 400 })
    }
    if (typeof budget_max_eur !== 'number' || budget_max_eur < 1) {
      return NextResponse.json({ error: 'budget_max_eur must be at least €1' }, { status: 400 })
    }
    if (budget_max_eur > MAX_TRANSACTION_EUR) {
      return NextResponse.json({
        error: `Mercatai currently supports transactions up to €${MAX_TRANSACTION_EUR}. Contact support for a higher-value assignment.`,
      }, { status: 400 })
    }
    if (typeof deadline_hours !== 'number' || deadline_hours < 1 || deadline_hours > 8760) {
      return NextResponse.json({ error: 'deadline_hours must be between 1 and 8760 (1 year)' }, { status: 400 })
    }

    const db = getSupabase()

    // org_name is free text from the request body — never an identity
    // lookup key, or anyone could type "Mercatai Sample Briefs" (or any
    // real customer's name) and have their task inherit that organization's
    // identity, trust, and posting history. Every task creation gets a
    // brand new organization row, even if org_name collides with an
    // existing one, and even if the caller presents a buyer_token —
    // buyer_token is scoped to the one task it was issued for (it's a
    // 30-day token, emailed in plain text, so widening what it authorizes
    // would widen the blast radius of a single leaked email far past what
    // its own holder should expect). A returning buyer posting a second
    // task under the same organization needs a dedicated, narrower
    // mechanism — not implemented yet; see the equivalent
    // join_token_lookup_id/join_token_secret_hash design on agent
    // registration in POST /api/v1/agents for the shape a future
    // organization-scoped token here should follow.
    const { data: newOrg, error: orgErr } = await db
      .from('organizations')
      .insert({ name: org_name || 'anonymous', verification_level: 'anonymous' })
      .select('id')
      .single()
    if (orgErr) throw orgErr
    const orgId: string = newOrg.id

    // Detect third-party API client for affiliate tracking + metered billing
    const apiClient = await resolveApiClient(request.headers.get('authorization'))
    if (apiClient) {
      const quota = await checkQuota(apiClient.id, apiClient.plan)
      if (!quota.allowed) {
        return NextResponse.json({
          error: `Monthly API quota exceeded (${quota.used}/${quota.limit} calls on ${quota.plan} plan). Upgrade at https://mercatai.eu/developer`,
          quota,
        }, { status: 429 })
      }
      trackApiCall(apiClient.id)
    }

    const biddingClosesAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()

    // Trust & Safety: moderate before this task can ever be seen. The
    // decision is persisted on the row itself, not just returned — every
    // downstream reader (GET /tasks, GET /tasks/[id], activity, bids)
    // filters on moderation_status, so an unreviewed or rejected task
    // simply doesn't exist from the outside no matter what code path
    // looks for it.
    const moderation = await moderateTask({
      title,
      description,
      budgetMinEur: budget_min_eur || 0,
      budgetMaxEur: budget_max_eur,
      category: category || 'research',
      organizationId: orgId,
    })
    const isPublic = moderation.decision === 'allow' || moderation.decision === 'allow_with_warning'
    const dbModerationStatus = isPublic ? 'approved' : moderation.decision === 'quarantine' ? 'quarantined' : 'rejected'

    const { data: task, error } = await db
      .from('tasks')
      .insert({
        posted_by_org_id: orgId,
        title,
        description,
        category: category || 'research',
        required_capabilities: required_capabilities || [],
        required_languages: required_languages || ['en'],
        budget_min_eur: budget_min_eur || 0,
        budget_max_eur,
        deadline_hours,
        status: 'open',
        bidding_closes_at: biddingClosesAt,
        ...(apiClient ? { referred_by_client_id: apiClient.id } : {}),
        ...(buyer_email ? { buyer_email } : {}),
        moderation_status: dbModerationStatus,
        moderation_risk_score: moderation.riskScore,
        moderation_reason_codes: moderation.reasonCodes,
        moderation_policy_version: moderation.policyVersion,
        moderated_at: new Date().toISOString(),
        moderated_by: 'system:auto',
        ...(isPublic ? { published_at: new Date().toISOString() } : {}),
      })
      .select()
      .single()

    if (error) throw error

    await auditLog({
      action: 'task_created',
      resource_type: 'task',
      resource_id: task.id,
      details: { title, budget_max_eur, moderation_status: dbModerationStatus },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })
    await recordModerationEvent({
      taskId: task.id,
      eventType: 'auto_moderated',
      actorType: 'system',
      decision: moderation.decision,
      riskScore: moderation.riskScore,
      reasonCodes: moderation.reasonCodes,
      policyVersion: moderation.policyVersion,
      notes: moderation.internalExplanation,
    })

    const buyerToken = await signToken(
      {
        role: 'buyer',
        task_id: task.id,
        org_id: orgId,
        ...(buyer_email ? { buyer_email } : {}),
      },
      '30d'  // 30 days — long enough to cover task lifecycle
    )

    if (!isPublic) {
      // Quarantined/rejected: persisted for audit and appeal, but never
      // published — no webhook, no auto-bid, no buyer-facing task object.
      return NextResponse.json({
        id: task.id,
        moderation_status: dbModerationStatus,
        reason_codes: moderation.reasonCodes,
        explanation: moderation.publicExplanation,
        policy_url: 'https://mercatai.eu/safety',
        appeal_available: true,
        buyer_token: buyerToken,
        buyer_token_note: 'Save this token — required to appeal this decision',
      }, { status: dbModerationStatus === 'quarantined' ? 202 : 422 })
    }

    // Fire webhooks async — do not await
    fireWebhooks('task.created', { task_id: task.id, title, category: task.category, budget_max_eur })

    // Auto-bidding + agent push notifications. Awaited so it completes before the
    // serverless function freezes; internally bounded and never throws.
    await runAutoBids({
      id: task.id,
      title: task.title,
      category: task.category,
      required_capabilities: task.required_capabilities,
      required_languages: task.required_languages,
      budget_min_eur: task.budget_min_eur,
      budget_max_eur: task.budget_max_eur,
      deadline_hours: task.deadline_hours,
    })

    // Send confirmation email if buyer provided their email (fire-and-forget)
    if (buyer_email && typeof buyer_email === 'string' && buyer_email.includes('@')) {
      sendTaskCreated({
        to: buyer_email,
        taskTitle: title,
        taskId: task.id,
        buyerToken,
        budgetMax: budget_max_eur,
      }).catch(console.error)
    }

    // Built explicitly, not spread from the raw row — that row also carries
    // moderation_risk_score, moderation_reason_codes and moderated_by,
    // which are internal-only (see moderateTask.ts's internalExplanation
    // vs publicExplanation split) and must never reach a public response.
    return NextResponse.json({
      id: task.id,
      title: task.title,
      description: task.description,
      category: task.category,
      required_capabilities: task.required_capabilities,
      required_languages: task.required_languages,
      budget_min_eur: task.budget_min_eur,
      budget_max_eur: task.budget_max_eur,
      deadline_hours: task.deadline_hours,
      status: task.status,
      bidding_closes_at: task.bidding_closes_at,
      created_at: task.created_at,
      buyer_token: buyerToken,
      buyer_token_note: 'Save this token — required to approve or dispute this task',
      ...(moderation.decision === 'allow_with_warning' ? { moderation_warning: moderation.publicExplanation } : {}),
    }, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
