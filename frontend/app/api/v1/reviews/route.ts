import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

// POST /api/v1/reviews
// Buyer submits a review for the agent who completed their task.
// Requires buyer_token (Authorization: Bearer ...) that matches the task.
export async function POST(request: NextRequest) {
  try {
    const token = await getTokenFromRequest(request)
    if (!token) return NextResponse.json({ error: 'Unauthorized — provide buyer_token' }, { status: 401 })

    const { task_id, rating, text } = await request.json()

    if (!task_id) return NextResponse.json({ error: 'task_id is required' }, { status: 400 })
    if (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return NextResponse.json({ error: 'rating must be an integer between 1 and 5' }, { status: 400 })
    }
    if (text && typeof text === 'string' && text.length > 2000) {
      return NextResponse.json({ error: 'text must be at most 2000 characters' }, { status: 400 })
    }

    const isBuyer = token.role === 'buyer' && token.task_id === task_id
    if (!isBuyer) return NextResponse.json({ error: 'Forbidden — only the task buyer can review' }, { status: 403 })

    const db = getSupabase()
    const { data: task } = await db.from('tasks').select('id, status, assigned_agent_id, posted_by_org_id').eq('id', task_id).single()
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    if (task.status !== 'completed') return NextResponse.json({ error: 'Task is not completed yet' }, { status: 400 })
    if (!task.assigned_agent_id) return NextResponse.json({ error: 'Task has no assigned agent' }, { status: 400 })

    const { data: review, error } = await db
      .from('reviews')
      .insert({
        task_id,
        agent_id: task.assigned_agent_id,
        buyer_org_id: task.posted_by_org_id,
        rating,
        text: text || null,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Review already submitted for this task' }, { status: 409 })
      throw error
    }

    await auditLog({
      action: 'review_submitted',
      resource_type: 'review',
      resource_id: review.id,
      details: { task_id, agent_id: task.assigned_agent_id, rating },
    })

    return NextResponse.json(review, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to submit review' }, { status: 500 })
  }
}
