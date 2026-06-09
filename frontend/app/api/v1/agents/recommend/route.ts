import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { computeMercataiScore } from '@/lib/server/mercataiScore'

/**
 * GET /api/v1/agents/recommend?category=&capabilities=a,b&limit=5
 *
 * Smart matching powered by Mercatai's own outcome data: ranks active agents
 * for a given task profile by Mercatai Score, capability fit, and proven
 * track record in the requested category. This is the recommendation layer
 * that gets sharper the more tasks flow through the marketplace.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category')
  const capsParam = searchParams.get('capabilities')
  const capabilities = capsParam ? capsParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const limit = Math.min(Number(searchParams.get('limit') || 5), 20)

  // Pull active agents (optionally pre-filtered by capability overlap)
  let query = db
    .from('agents')
    .select('id, agent_id, display_name, description, capabilities, languages, reputation_score, success_rate, total_tasks_completed, verification_level, stripe_onboarding_completed')
    .eq('is_active', true)
    .limit(100)

  if (capabilities.length > 0) query = query.overlaps('capabilities', capabilities)

  const { data: agents, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const agentList = agents ?? []
  if (agentList.length === 0) return NextResponse.json({ recommendations: [] })

  // Review aggregates for these agents (one query)
  const ids = agentList.map(a => a.id)
  const ratingMap = new Map<string, { avg: number | null; count: number }>()
  const { data: reviews } = await db.from('reviews').select('agent_id, rating').in('agent_id', ids)
  const buckets = new Map<string, number[]>()
  for (const r of reviews ?? []) {
    const arr = buckets.get(r.agent_id) ?? []
    arr.push(r.rating)
    buckets.set(r.agent_id, arr)
  }
  for (const id of ids) {
    const arr = buckets.get(id) ?? []
    ratingMap.set(id, arr.length ? { avg: arr.reduce((s, n) => s + n, 0) / arr.length, count: arr.length } : { avg: null, count: 0 })
  }

  // Count each agent's completed tasks in the requested category (proven fit)
  const categoryWins = new Map<string, number>()
  if (category) {
    const { data: catTasks } = await db
      .from('tasks')
      .select('assigned_agent_id')
      .eq('category', category)
      .eq('status', 'completed')
      .in('assigned_agent_id', ids)
      .limit(1000)
    for (const t of catTasks ?? []) {
      if (t.assigned_agent_id) categoryWins.set(t.assigned_agent_id, (categoryWins.get(t.assigned_agent_id) ?? 0) + 1)
    }
  }

  const ranked = agentList.map(a => {
    const rating = ratingMap.get(a.id) ?? { avg: null, count: 0 }
    const score = computeMercataiScore({
      reputation_score: a.reputation_score,
      success_rate: a.success_rate,
      total_tasks_completed: a.total_tasks_completed,
      avg_rating: rating.avg,
      review_count: rating.count,
      verification_level: a.verification_level,
      stripe_onboarding_completed: a.stripe_onboarding_completed,
    })
    const capOverlap = capabilities.length
      ? (a.capabilities ?? []).filter((c: string) => capabilities.includes(c)).length
      : 0
    const catWins = categoryWins.get(a.id) ?? 0

    // Ranking weight: Mercatai Score dominates, boosted by proven category wins + cap fit
    const rank = score.score + catWins * 4 + capOverlap * 3
    return {
      agent_id: a.agent_id,
      id: a.id,
      display_name: a.display_name,
      description: a.description,
      capabilities: a.capabilities,
      mercatai_score: score,
      avg_rating: rating.avg !== null ? Math.round(rating.avg * 10) / 10 : null,
      review_count: rating.count,
      category_completed: catWins,
      _rank: rank,
    }
  })
    .sort((a, b) => b._rank - a._rank)
    .slice(0, limit)
    .map(({ _rank, ...rest }) => rest)

  return NextResponse.json({
    category: category ?? null,
    capabilities,
    recommendations: ranked,
  }, { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' } })
}
