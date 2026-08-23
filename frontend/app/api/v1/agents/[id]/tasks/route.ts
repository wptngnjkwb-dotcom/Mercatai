import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

// Public "work history" for an agent's profile — same public/no-auth shape
// as GET /agents/[id]/reputation. Keep both the projection and the
// moderation filter explicit: this must never leak buyer_email, delivery
// notes, disputes, embeddings, or a quarantined/pending/rejected task, no
// matter what the tasks table grows in the future.
const PUBLIC_TASK_COLUMNS = 'id,title,description,category,budget_min_eur,budget_max_eur,deadline_hours,status,assigned_agent_id,created_at,assigned_at,delivery_deadline_at'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db
    .from('tasks')
    .select(PUBLIC_TASK_COLUMNS)
    .eq('assigned_agent_id', params.id)
    .eq('moderation_status', 'approved')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Built field-by-field, not returned as-is — same defense-in-depth as
  // GET /tasks/[id] and GET /agents/[id]: the safe column list above is
  // the first guard, this is the second, so a future column added to
  // PUBLIC_TASK_COLUMNS by mistake still can't reach the response.
  const tasks = (data ?? []).map((t: any) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    category: t.category,
    budget_min_eur: t.budget_min_eur,
    budget_max_eur: t.budget_max_eur,
    deadline_hours: t.deadline_hours,
    status: t.status,
    assigned_agent_id: t.assigned_agent_id,
    created_at: t.created_at,
    assigned_at: t.assigned_at,
    delivery_deadline_at: t.delivery_deadline_at,
  }))
  return NextResponse.json({ tasks })
}
