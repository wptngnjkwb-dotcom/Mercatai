import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

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
  category?: string
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
    const { data } = await db
      .from('bids')
      .select('id, price_eur, submitted_at, tasks(title, category), agents(display_name)')
      .order('submitted_at', { ascending: false })
      .limit(15)
    return (data ?? []).map((b: any): ActivityEvent => ({
      id: `bid-${b.id}`,
      type: 'bid',
      title: b.agents?.display_name
        ? `${b.agents.display_name} placed a bid`
        : 'New bid placed',
      detail: b.tasks?.title ?? 'a task',
      amount_eur: b.price_eur,
      category: b.tasks?.category,
      at: b.submitted_at ?? new Date().toISOString(),
    }))
  }, [] as ActivityEvent[])

  // ── Recently posted tasks ────────────────────────────────────────────────
  const recentTasks = await safe(async () => {
    const { data } = await db
      .from('tasks')
      .select('id, title, category, budget_max_eur, created_at, status')
      .order('created_at', { ascending: false })
      .limit(15)
    return (data ?? []).map((t: any): ActivityEvent => ({
      id: `task-${t.id}`,
      type: t.status === 'completed' ? 'completed' : 'task',
      title: t.status === 'completed' ? 'Task completed' : 'New task posted',
      detail: t.title,
      amount_eur: t.budget_max_eur,
      category: t.category,
      at: t.created_at ?? new Date().toISOString(),
    }))
  }, [] as ActivityEvent[])

  // ── Merge + sort by time, newest first ───────────────────────────────────
  const events = [...recentBids, ...recentTasks]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 25)

  // ── Headline stats ───────────────────────────────────────────────────────
  const [tasksTotal, bidsTotal, agentsTotal, completedTotal] = await Promise.all([
    safe(async () => (await db.from('tasks').select('id', { count: 'exact', head: true })).count ?? 0, 0),
    safe(async () => (await db.from('bids').select('id', { count: 'exact', head: true })).count ?? 0, 0),
    safe(async () => (await db.from('agents').select('id', { count: 'exact', head: true }).eq('is_active', true)).count ?? 0, 0),
    safe(async () => (await db.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'completed')).count ?? 0, 0),
  ])

  // Approximate GMV from completed task budgets (sampled, capped for cost)
  const gmvEur = await safe(async () => {
    const { data } = await db
      .from('tasks')
      .select('budget_max_eur')
      .eq('status', 'completed')
      .limit(500)
    return (data ?? []).reduce((sum: number, t: any) => sum + (t.budget_max_eur ?? 0), 0)
  }, 0)

  return NextResponse.json({
    events,
    stats: {
      tasks_total: tasksTotal,
      bids_total: bidsTotal,
      agents_active: agentsTotal,
      tasks_completed: completedTotal,
      gmv_eur: gmvEur,
    },
    generated_at: new Date().toISOString(),
  })
}
