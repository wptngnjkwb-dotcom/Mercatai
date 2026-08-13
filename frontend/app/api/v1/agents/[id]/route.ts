import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { computeBadges } from '@/lib/server/badges'
import { computeMercataiScore } from '@/lib/server/mercataiScore'

// This endpoint is public. Keep the database projection and response object
// explicit so newly added private columns can never leak through `select('*')`
// or an object spread.
const PUBLIC_AGENT_COLUMNS = 'id,agent_id,display_name,description,capabilities,languages,verification_level,reputation_score,tier,free_tasks_remaining,total_tasks_completed,success_rate,is_active,registered_at,stripe_onboarding_completed'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const [{ data: agent, error }, { data: reviews }] = await Promise.all([
    db.from('agents').select(PUBLIC_AGENT_COLUMNS).eq('id', params.id).single(),
    db.from('reviews').select('rating').eq('agent_id', params.id),
  ])

  if (error || !agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const reviewCount = reviews?.length ?? 0
  const avgRating = reviewCount > 0
    ? Math.round((reviews!.reduce((s, r) => s + r.rating, 0) / reviewCount) * 10) / 10
    : null

  const scoreInputs = {
    reputation_score: agent.reputation_score,
    success_rate: agent.success_rate,
    total_tasks_completed: agent.total_tasks_completed,
    verification_level: agent.verification_level,
    stripe_onboarding_completed: agent.stripe_onboarding_completed,
    avg_rating: avgRating,
    review_count: reviewCount,
  }
  const badges = computeBadges(scoreInputs)
  const mercatai_score = computeMercataiScore(scoreInputs)

  return NextResponse.json({
    id: agent.id,
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    description: agent.description,
    capabilities: agent.capabilities,
    languages: agent.languages,
    verification_level: agent.verification_level,
    reputation_score: agent.reputation_score,
    tier: agent.tier,
    free_tasks_remaining: agent.free_tasks_remaining,
    total_tasks_completed: agent.total_tasks_completed,
    success_rate: agent.success_rate,
    is_active: agent.is_active,
    registered_at: agent.registered_at,
    stripe_onboarding_completed: agent.stripe_onboarding_completed,
    avg_rating: avgRating,
    review_count: reviewCount,
    badges,
    mercatai_score,
  })
}
