import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { computeSettledMetrics, fetchSeedOrgIds } from '@/lib/server/publicTaskFields'

/**
 * Public platform activity feed — powers the live "/live" page.
 *
 * Returns anonymized recent events (bids placed, tasks posted, tasks completed)
 * plus headline marketplace stats. No auth required; safe for public display.
 *
 * Every sub-query is wrapped so a single failure degrades gracefully instead of
 * breaking the whole feed.
 */

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface ActivityEvent {
  id: string
  type: 'bid' | 'task' | 'completed'
  title: string
  detail: string
  amount_eur?: number
  /** What amount_eur actually represents — never let a budget or bid read as a settled payment. */
  amount_kind?: 'budget' | 'bid' | 'settled'
  category?: string
  is_demo?: boolean
  at: string
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export async function GET(_request: NextRequest) {
  const db = getSupabase()

  // ── Recent bids (with task + agent context) ──────────────────────────────
  const recentBids = await safe(async () => {
    const { data, error } = await db
      .from('bids')
      .select('id, price_eur, submitted_at, tasks(title, category, moderation_status, posted_by_org_id), agents(display_name)')
      .order('submitted_at', { ascending: false })
      .limit(15)
    if (error) throw error
    // A bid on a quarantined/rejected/pending task is exactly as private
    // as the task itself — filtered defensively here rather than trusting
    // an embedded-relation query filter, which PostgREST only applies
    // reliably with an explicit inner-join hint.
    const rows = (data ?? []).filter((b: any) => b.tasks?.moderation_status === 'approved')
    const orgIds = Array.from(new Set(rows.map((b: any) => b.tasks?.posted_by_org_id).filter(Boolean)))
    const seedOrgIds = await fetchSeedOrgIds(db, orgIds)
    return rows.map((b: any): ActivityEvent => ({
      id: `bid-${b.id}`,
      type: 'bid',
      title: b.agents?.display_name
        ? `${b.agents.display_name} placed a bid`
        : 'New bid placed',
      detail: b.tasks?.title ?? 'a task',
      amount_eur: b.price_eur,
      amount_kind: 'bid',
      category: b.tasks?.category,
      is_demo: !!b.tasks?.posted_by_org_id && seedOrgIds.has(b.tasks.posted_by_org_id),
      at: b.submitted_at ?? new Date().toISOString(),
    }))
  }, [] as ActivityEvent[])

  // ── Recently posted tasks — never "completed" here, see settledCompletions
  //    below; tasks.status='completed' is a workflow milestone, not proof a
  //    real payment was ever released. ─────────────────────────────────────
  const recentTasks = await safe(async () => {
    const { data, error } = await db
      .from('tasks')
      .select('id, title, category, budget_max_eur, created_at, posted_by_org_id')
      // Trust & Safety: never surface a quarantined/rejected/unreviewed
      // task on the public activity feed.
      .eq('moderation_status', 'approved')
      .order('created_at', { ascending: false })
      .limit(15)
    if (error) throw error
    const rows = data ?? []
    const orgIds = Array.from(new Set(rows.map((t: any) => t.posted_by_org_id).filter(Boolean)))
    const seedOrgIds = await fetchSeedOrgIds(db, orgIds)
    return rows.map((t: any): ActivityEvent => ({
      id: `task-${t.id}`,
      type: 'task',
      title: 'New task posted',
      detail: t.title,
      amount_eur: t.budget_max_eur,
      amount_kind: 'budget',
      category: t.category,
      is_demo: !!t.posted_by_org_id && seedOrgIds.has(t.posted_by_org_id),
      at: t.created_at ?? new Date().toISOString(),
    }))
  }, [] as ActivityEvent[])

  // ── Real completions — built only from released, non-demo transactions,
  //    using the transaction's actual amount and its released_at time, not
  //    the task's budget or creation time. ─────────────────────────────────
  const settledCompletions = await safe(async () => {
    const { data: txRows, error: txErr } = await db
      .from('transactions')
      .select('task_id, gross_amount_eur, released_at')
      .eq('escrow_status', 'released')
      .order('released_at', { ascending: false })
      .limit(15)
    if (txErr) throw txErr
    const rows = txRows ?? []
    if (rows.length === 0) return [] as ActivityEvent[]

    const taskIds = Array.from(new Set(rows.map((r: any) => r.task_id)))
    const { data: taskRows, error: taskErr } = await db
      .from('tasks')
      .select('id, title, category, posted_by_org_id')
      .in('id', taskIds)
    if (taskErr) throw taskErr
    const taskById = new Map((taskRows ?? []).map((t: any) => [t.id, t]))

    const orgIds = Array.from(new Set(Array.from(taskById.values()).map((t: any) => t.posted_by_org_id).filter(Boolean)))
    const seedOrgIds = await fetchSeedOrgIds(db, orgIds)

    const events: ActivityEvent[] = []
    for (const tx of rows as any[]) {
      const task = taskById.get(tx.task_id)
      if (!task) continue // can't verify this transaction's task/org — never surface an unverifiable completion
      // Demo tasks never produce a "completed" event, full stop — not even
      // marked — a paid-completion signal is the one place a "this is only
      // a demo" caveat is not enough; it simply must not appear.
      if (task.posted_by_org_id && seedOrgIds.has(task.posted_by_org_id)) continue
      events.push({
        id: `completed-${tx.task_id}`,
        type: 'completed',
        title: 'Task completed',
        detail: task.title,
        amount_eur: Number(tx.gross_amount_eur ?? 0),
        amount_kind: 'settled',
        category: task.category,
        is_demo: false,
        at: tx.released_at ?? new Date().toISOString(),
      })
    }
    return events
  }, [] as ActivityEvent[])

  // ── Merge + sort by time, newest first ───────────────────────────────────
  const events = [...recentBids, ...recentTasks, ...settledCompletions]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 25)

  // ── Headline stats ───────────────────────────────────────────────────────
  // tasks_total / bids_total / agents_active below, and the events feed
  // above, include demo/sample activity (clearly marked via is_demo) —
  // only tasks_completed and gmv_eur are scoped to real, released,
  // non-demo transactions. See stats.metrics_scope.
  const [tasksTotal, bidsTotal, agentsTotal] = await Promise.all([
    safe(async () => (await db.from('tasks').select('id', { count: 'exact', head: true }).eq('moderation_status', 'approved')).count ?? 0, 0),
    safe(async () => (await db.from('bids').select('id', { count: 'exact', head: true })).count ?? 0, 0),
    safe(async () => (await db.from('agents').select('id', { count: 'exact', head: true }).eq('is_active', true)).count ?? 0, 0),
  ])

  // tasks_completed / gmv_eur used to be derived from tasks.status='completed'
  // and budget_max_eur — a workflow milestone and an asking price, neither of
  // which means money actually moved. Real business metrics: a task counts
  // once, only for a transaction that reached escrow_status='released', using
  // that transaction's actual settled amount, excluding the platform's own
  // seed/demo organization. See lib/server/publicTaskFields.ts.
  const settled = await safe(computeSettledMetrics.bind(null, db), { tasksCompleted: 0, gmvEur: 0 })

  return NextResponse.json({
    events,
    stats: {
      tasks_total: tasksTotal,
      bids_total: bidsTotal,
      agents_active: agentsTotal,
      tasks_completed: settled.tasksCompleted,
      gmv_eur: settled.gmvEur,
      // Machine-readable scope of tasks_completed/gmv_eur above — released,
      // non-demo transactions only. Not every consumer needs this, but none
      // should be able to mistake these numbers for anything broader.
      metrics_scope: 'released_non_demo_transactions',
    },
    generated_at: new Date().toISOString(),
  })
}
