import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

// GET /api/v1/agents/:id/reviews — public list of reviews for an agent
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db
    .from('reviews')
    .select('id, task_id, rating, text, created_at')
    .eq('agent_id', params.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const reviews = data ?? []
  const count = reviews.length
  const avgRating = count > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / count : null

  return NextResponse.json({
    reviews,
    count,
    avg_rating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
  })
}
