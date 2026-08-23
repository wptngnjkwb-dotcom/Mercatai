import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

export const dynamic = 'force-dynamic'

const TASK_COLUMNS = 'id,title,description,category,budget_min_eur,budget_max_eur,moderation_status,moderation_risk_score,moderation_reason_codes,moderation_policy_version,moderated_at,moderated_by,created_at,posted_by_org_id'

// Moderation queue: tasks awaiting or already given a moderation decision,
// plus any appeal pending admin resolution. Never returns 'pending' tasks
// alongside truly public ones — this is an admin-only view of exactly the
// column set the public endpoints deliberately hide (see PUBLIC_TASK_COLUMNS
// in GET /tasks/[id]).
export async function GET(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const validStatuses = ['pending', 'approved', 'quarantined', 'rejected']

  let taskQuery = db.from('tasks').select(TASK_COLUMNS)
  taskQuery = status && validStatuses.includes(status)
    ? taskQuery.eq('moderation_status', status)
    // Default view: the actionable queue, not the whole task table.
    : taskQuery.in('moderation_status', ['pending', 'quarantined'])

  const [{ data: tasks }, { data: appeals }] = await Promise.all([
    taskQuery.order('created_at', { ascending: false }).limit(200),
    db.from('task_moderation_appeals').select('id,task_id,buyer_org_id,message,status,statement_of_reasons,resolved_by,created_at,resolved_at').eq('status', 'pending').order('created_at', { ascending: true }),
  ])

  const orgIds = Array.from(new Set([...(tasks ?? []).map(t => t.posted_by_org_id), ...(appeals ?? []).map(a => a.buyer_org_id)].filter(Boolean)))
  const taskIds = (tasks ?? []).map(t => t.id)

  const [{ data: orgs }, { data: reportRows }, { data: appealTasks }] = await Promise.all([
    orgIds.length > 0 ? db.from('organizations').select('id,name,is_suspended').in('id', orgIds) : Promise.resolve({ data: [] }),
    taskIds.length > 0 ? db.from('task_reports').select('task_id').in('task_id', taskIds) : Promise.resolve({ data: [] }),
    (appeals ?? []).length > 0 ? db.from('tasks').select('id,title').in('id', (appeals ?? []).map(a => a.task_id)) : Promise.resolve({ data: [] }),
  ])

  const orgById = new Map((orgs ?? []).map(o => [o.id, o]))
  const reportCountByTask = new Map<string, number>()
  for (const r of reportRows ?? []) {
    reportCountByTask.set(r.task_id, (reportCountByTask.get(r.task_id) ?? 0) + 1)
  }
  const taskTitleById = new Map((appealTasks ?? []).map(t => [t.id, t.title]))

  return NextResponse.json({
    tasks: (tasks ?? []).map(t => ({
      ...t,
      organization_name: orgById.get(t.posted_by_org_id)?.name ?? null,
      organization_suspended: orgById.get(t.posted_by_org_id)?.is_suspended ?? false,
      report_count: reportCountByTask.get(t.id) ?? 0,
    })),
    appeals: (appeals ?? []).map(a => ({
      ...a,
      task_title: taskTitleById.get(a.task_id) ?? null,
      organization_name: orgById.get(a.buyer_org_id)?.name ?? null,
    })),
  })
}
