import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { computeBadges } from '@/lib/server/badges'
import { computeMercataiScore } from '@/lib/server/mercataiScore'
import { getTokenFromRequest } from '@/lib/server/auth'
import { isAgentVisibleTo, withPrivateCacheHeaders } from '@/lib/server/agentVisibility'
import { fetchEligibleAgentReviews } from '@/lib/server/eligibleAgentReviews'
import { detectOffPlatformContact } from '@/lib/server/offPlatformContact'

// This endpoint is public for a public agent. Keep the database projection
// and response object explicit so newly added private columns can never
// leak through `select('*')` or an object spread.
const PUBLIC_AGENT_COLUMNS = 'id,agent_id,display_name,description,capabilities,languages,verification_level,reputation_score,tier,free_tasks_remaining,total_tasks_completed,success_rate,is_active,registered_at,stripe_standard_onboarding_completed,profile_visibility'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const { data: agent, error } = await db
    .from('agents')
    .select(PUBLIC_AGENT_COLUMNS)
    .eq('id', params.id)
    .single()

  if (error || !agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  // A private agent's profile 404s for anyone but itself or an admin — a
  // 403 here would itself confirm a hidden agent exists at this id.
  const token = await getTokenFromRequest(request)
  if (!isAgentVisibleTo(token, agent)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  const profileHasContact = detectOffPlatformContact(
    [agent.agent_id, agent.display_name, agent.description],
    { blockExternalUrls: true },
  ).blocked
  const canInspectUnsafeProfile = token?.tier === 'admin' || token?.agent_id === agent.id
  if (profileHasContact && !canInspectUnsafeProfile) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  let reviews
  try {
    reviews = await fetchEligibleAgentReviews(db, params.id)
  } catch (reviewError) {
    console.error('Eligible agent ratings could not be computed', reviewError instanceof Error ? reviewError.message : 'Unknown error')
    return NextResponse.json({ error: 'Agent ratings are temporarily unavailable' }, { status: 503 })
  }

  const reviewCount = reviews.length
  const avgRating = reviewCount > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviewCount) * 10) / 10
    : null

  const scoreInputs = {
    reputation_score: agent.reputation_score,
    success_rate: agent.success_rate,
    total_tasks_completed: agent.total_tasks_completed,
    verification_level: agent.verification_level,
    stripe_onboarding_completed: agent.stripe_standard_onboarding_completed,
    avg_rating: avgRating,
    review_count: reviewCount,
  }
  const badges = computeBadges(scoreInputs)
  const mercatai_score = computeMercataiScore(scoreInputs)

  const response = NextResponse.json({
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
    stripe_onboarding_completed: agent.stripe_standard_onboarding_completed,
    profile_visibility: agent.profile_visibility,
    avg_rating: avgRating,
    review_count: reviewCount,
    badges,
    mercatai_score,
  })
  // Visibility can change at any time, so even a currently-public profile
  // must not survive in a shared cache after the agent switches to private.
  return withPrivateCacheHeaders(response)
}
