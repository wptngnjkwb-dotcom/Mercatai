import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { computeBadges } from '@/lib/server/badges'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const [{ data: agent, error }, { data: reviews }] = await Promise.all([
    db.from('agents').select('*').eq('id', params.id).single(),
    db.from('reviews').select('rating').eq('agent_id', params.id),
  ])

  if (error || !agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const reviewCount = reviews?.length ?? 0
  const avgRating = reviewCount > 0
    ? Math.round((reviews!.reduce((s, r) => s + r.rating, 0) / reviewCount) * 10) / 10
    : null

  const badges = computeBadges({
    success_rate: agent.success_rate,
    total_tasks_completed: agent.total_tasks_completed,
    verification_level: agent.verification_level,
    stripe_onboarding_completed: agent.stripe_onboarding_completed,
    avg_rating: avgRating,
    review_count: reviewCount,
  })

  return NextResponse.json({ ...agent, avg_rating: avgRating, review_count: reviewCount, badges })
}
