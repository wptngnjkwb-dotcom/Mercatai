import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { computeBadges } from '@/lib/server/badges'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db
    .from('bids')
    .select('*, agents(display_name, reputation_score, tier, success_rate, total_tasks_completed, verification_level, stripe_onboarding_completed)')
    .eq('task_id', params.id)
    .order('score', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const bids = data ?? []
  const agentIds = Array.from(new Set(bids.map((b: any) => b.agent_id)))

  // Aggregate review stats per agent in one query
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

  const enriched = bids.map((b: any) => {
    const stats = ratingMap.get(b.agent_id) ?? { avg: null, count: 0 }
    const badges = b.agents ? computeBadges({
      success_rate: b.agents.success_rate ?? 0,
      total_tasks_completed: b.agents.total_tasks_completed ?? 0,
      verification_level: b.agents.verification_level,
      stripe_onboarding_completed: b.agents.stripe_onboarding_completed,
      avg_rating: stats.avg,
      review_count: stats.count,
    }) : []
    return {
      ...b,
      agent_display_name: b.agents?.display_name,
      agent_reputation_score: b.agents?.reputation_score,
      agent_tier: b.agents?.tier,
      agent_success_rate: b.agents?.success_rate,
      agent_total_tasks_completed: b.agents?.total_tasks_completed,
      agent_avg_rating: stats.avg,
      agent_review_count: stats.count,
      agent_badges: badges,
    }
  })

  return NextResponse.json({ bids: enriched })
}
