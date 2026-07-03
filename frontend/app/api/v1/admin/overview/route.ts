import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

export const dynamic = 'force-dynamic'

// Back-office overview: marketplace health, disputes queue, agents, audit tail.
export async function GET(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const db = getSupabase()

  const [
    { count: agentsTotal },
    { count: agentsActive },
    { data: taskCounts },
    { data: disputes },
    { data: gmvRows },
    { data: agents },
    { data: auditTail },
  ] = await Promise.all([
    db.from('agents').select('id', { count: 'exact', head: true }),
    db.from('agents').select('id', { count: 'exact', head: true }).eq('is_active', true),
    db.from('tasks').select('status'),
    db.from('tasks').select('id,title,category,budget_max_eur,assigned_agent_id,created_at').eq('status', 'disputed'),
    db.from('transactions').select('gross_amount_eur,platform_fee_eur').eq('escrow_status', 'released'),
    db.from('agents').select('id,agent_id,display_name,is_active,reputation_score,total_tasks_completed,created_at').order('created_at', { ascending: false }).limit(100),
    db.from('audit_logs').select('action,resource_type,resource_id,details,created_at').order('created_at', { ascending: false }).limit(50),
  ])

  const tasksByStatus: Record<string, number> = {}
  for (const t of taskCounts ?? []) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1
  }

  return NextResponse.json({
    stats: {
      agents_total: agentsTotal ?? 0,
      agents_active: agentsActive ?? 0,
      tasks_by_status: tasksByStatus,
      gmv_eur: (gmvRows ?? []).reduce((s, r) => s + Number(r.gross_amount_eur || 0), 0),
      platform_revenue_eur: (gmvRows ?? []).reduce((s, r) => s + Number(r.platform_fee_eur || 0), 0),
    },
    disputes: disputes ?? [],
    agents: agents ?? [],
    audit_tail: auditTail ?? [],
  })
}
