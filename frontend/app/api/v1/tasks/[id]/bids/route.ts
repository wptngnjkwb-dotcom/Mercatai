import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { computeBadges } from '@/lib/server/badges'
import { computeMercataiScore } from '@/lib/server/mercataiScore'
import { isAgentVisibleTo, withPrivateCacheHeaders } from '@/lib/server/agentVisibility'

// This is the main boundary between a private agent's bid identity and
// everyone who isn't the task's buyer, the agent itself, or an admin — keep
// both the bids projection and the agents projection explicit (never
// select('*')) and build the response objects field-by-field (never spread
// a raw row), so a column added to either table later can't leak through
// here by accident. See frontend/lib/server/agentVisibility.ts.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  // A quarantined/rejected/pending task's bids are exactly as private as
  // the task itself — same 404 GET /tasks/[id] gives a non-approved task,
  // so this route can't be used to confirm a hidden task's existence or
  // read its bid activity (price, agent names) around the ban.
  const { data: task } = await db.from('tasks').select('id, moderation_status').eq('id', params.id).single()
  if (!task || task.moderation_status !== 'approved') {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  const { data, error } = await db
    .from('bids')
    .select('id, task_id, agent_id, price_eur, delivery_hours, approach_summary, sample_preview, score, status, submitted_at, agents(id, display_name, reputation_score, tier, success_rate, total_tasks_completed, verification_level, stripe_onboarding_completed, profile_visibility)')
    .eq('task_id', params.id)
    .order('score', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const bids = data ?? []

  // A caller can be: this task's own buyer (buyer_token, task-bound), the
  // bidding agent itself, an admin, or nobody in particular (anonymous, a
  // different agent's token, or a buyer token for a different task) — the
  // last group gets every private bid filtered out entirely below, not
  // masked or partially shown.
  const token = await getTokenFromRequest(request)
  const visibleBids = bids.filter((b: any) => {
    const agent = b.agents as { id: string; profile_visibility?: string | null } | null
    if (!agent) return false // orphaned bid row with no matching agent — nothing safe to show
    return isAgentVisibleTo(token, agent, { taskId: params.id })
  })

  const agentIds = Array.from(new Set(visibleBids.map((b: any) => b.agent_id)))

  // Aggregate review stats per agent in one query — only for the agents
  // whose bids actually made it past the visibility filter above.
  const ratingMap = new Map<string, { avg: number | null; count: number }>()
  if (agentIds.length > 0) {
    const { data: reviews } = await db
      .from('reviews')
      .select('agent_id, rating')
      .in('agent_id', agentIds)

    const buckets = new Map<string, number[]>()
    for (const r of reviews ?? []) {
      const arr = buckets.get(r.agent_id) ?? []
      arr.push(r.rating)
      buckets.set(r.agent_id, arr)
    }
    for (const id of agentIds) {
      const arr = buckets.get(id) ?? []
      if (arr.length === 0) {
        ratingMap.set(id, { avg: null, count: 0 })
      } else {
        const avg = arr.reduce((s, n) => s + n, 0) / arr.length
        ratingMap.set(id, { avg: Math.round(avg * 10) / 10, count: arr.length })
      }
    }
  }

  const enriched = visibleBids.map((b: any) => {
    const agent = b.agents as Record<string, any> | null
    const agentIsPrivate = agent?.profile_visibility !== 'public'
    const stats = ratingMap.get(b.agent_id) ?? { avg: null, count: 0 }
    const scoreInputs = {
      reputation_score: agent?.reputation_score,
      success_rate: agent?.success_rate ?? 0,
      total_tasks_completed: agent?.total_tasks_completed ?? 0,
      verification_level: agent?.verification_level,
      stripe_onboarding_completed: agent?.stripe_onboarding_completed,
      avg_rating: stats.avg,
      review_count: stats.count,
    }
    const badges = agent ? computeBadges(scoreInputs) : []
    const mercataiScore = agent ? computeMercataiScore(scoreInputs) : undefined

    // Explicit field list — never spread `b` or `agent` — so owner_email,
    // Stripe fields, or any other private column can never reach a bid
    // response just because it happens to exist on the row.
    return {
      id: b.id,
      task_id: b.task_id,
      // The bid id is all a buyer needs to accept/reject it. Do not expose
      // the private agent's internal UUID even to the task counterparty;
      // its chosen display name and reputation are the bounded identity the
      // buyer needs for selection.
      agent_id: agentIsPrivate ? null : b.agent_id,
      agent_is_private: agentIsPrivate,
      price_eur: b.price_eur,
      delivery_hours: b.delivery_hours,
      approach_summary: b.approach_summary,
      sample_preview: b.sample_preview,
      status: b.status,
      score: b.score,
      submitted_at: b.submitted_at,
      agent_display_name: agent?.display_name,
      agent_reputation_score: agent?.reputation_score,
      agent_tier: agent?.tier,
      agent_success_rate: agent?.success_rate,
      agent_total_tasks_completed: agent?.total_tasks_completed,
      agent_avg_rating: stats.avg,
      agent_review_count: stats.count,
      agent_badges: badges,
      agent_mercatai_score: mercataiScore,
    }
  })

  // Which bids are visible depends on the Authorization header (buyer/
  // agent/admin token vs. anonymous), so this response must never be
  // served from a shared cache to a different caller.
  return withPrivateCacheHeaders(NextResponse.json({ bids: enriched }))
}
