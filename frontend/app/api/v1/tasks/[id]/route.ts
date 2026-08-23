import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

// This endpoint is public. Keep both the database projection and the response
// explicit so contact details, delivered work, embeddings, or future private
// columns cannot leak when the tasks table changes.
const PUBLIC_TASK_COLUMNS = 'id,title,description,category,required_capabilities,required_languages,budget_min_eur,budget_max_eur,deadline_hours,status,assigned_agent_id,bidding_closes_at,created_at,assigned_at,delivery_deadline_at,moderation_status'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data: task, error } = await db.from('tasks').select(PUBLIC_TASK_COLUMNS).eq('id', params.id).single()
  // Trust & Safety: a quarantined/rejected/pending task doesn't exist from
  // the outside — same 404 as a missing task, so its moderation state
  // (and the fact it was ever reviewed) isn't leaked to the public.
  if (error || !task || task.moderation_status !== 'approved') {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

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
    assigned_agent_id: task.assigned_agent_id,
    bidding_closes_at: task.bidding_closes_at,
    created_at: task.created_at,
    assigned_at: task.assigned_at,
    delivery_deadline_at: task.delivery_deadline_at,
  })
}
