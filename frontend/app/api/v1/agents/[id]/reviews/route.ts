import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { fetchAgentVisibilityRow, isAgentVisibleTo, withPrivateCacheHeaders } from '@/lib/server/agentVisibility'
import { fetchEligibleAgentReviews } from '@/lib/server/eligibleAgentReviews'

// GET /api/v1/agents/:id/reviews — public list of reviews for an agent
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const agent = await fetchAgentVisibilityRow(db, params.id)
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  const token = await getTokenFromRequest(request)
  if (!isAgentVisibleTo(token, agent)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  let reviews
  try {
    reviews = await fetchEligibleAgentReviews(db, params.id)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Reviews are temporarily unavailable' }, { status: 500 })
  }
  const count = reviews.length
  const avgRating = count > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / count : null

  const response = NextResponse.json({
    // task_id is used internally for eligibility checks, but can identify a
    // private Store/direct-offer relationship and must not leave this route.
    reviews: reviews.slice(0, 100).map(({ task_id: _taskId, ...review }) => review),
    count,
    avg_rating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
  })
  return withPrivateCacheHeaders(response)
}
