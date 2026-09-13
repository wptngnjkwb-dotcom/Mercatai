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

const FEED_PAGE_SIZE = 50
const FEED_MAX_PAGES = 20

/**
 * Fetches deterministic pages of `pageSize` raw rows (via `.range`) and
 * keeps only the ones `isVisible` allows, until `targetCount` visible rows
 * are collected or a page comes back short (no more data). A flat
 * `.limit(N)` on the unfiltered query would apply the cutoff before
 * visibility is known, so a backlog of hidden (archived/moderated/private)
 * rows newer than a real one could push that real row out of the feed
 * entirely — this fetches enough raw rows, in order, to find N *visible*
 * ones instead. Throws on any page's error — a partial, unverifiable page
 * must never be silently treated as "no more data".
 */
async function fetchVisibleRows<T>(
  fetchPage: (offset: number, pageSize: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  isVisible: (row: T) => boolean,
  targetCount: number
): Promise<T[]> {
  const results: T[] = []
  for (let page = 0; page < FEED_MAX_PAGES; page++) {
    const offset = page * FEED_PAGE_SIZE
    const { data, error } = await fetchPage(offset, FEED_PAGE_SIZE)
    if (error) throw error
    const rows = data ?? []
    for (const row of rows) {
      if (isVisible(row)) {
        results.push(row)
        if (results.length >= targetCount) return results
      }
    }
    if (rows.length < FEED_PAGE_SIZE) break
  }
  return results
}

interface BidRow {
  id: string
  price_eur: number
  submitted_at: string | null
  tasks: { title?: string; category?: string; moderation_status?: string; posted_by_org_id?: string | null; archived_at?: string | null } | null
  agents: { display_name?: string; profile_visibility?: string } | null
}

export async function GET(_request: NextRequest) {
  const db = getSupabase()

  // ── Recent bids (with task + agent context) ──────────────────────────────
  const recentBids = await safe(async () => {
    // A bid on a quarantined/rejected/pending/archived task is exactly as
    // private as the task itself — filtered defensively here rather than
    // trusting an embedded-relation query filter, which PostgREST only
    // applies reliably with an explicit inner-join hint. A private agent's
    // bid is dropped from this public feed entirely, the same way — not
    // anonymized, since even an unnamed "someone placed a bid" event would
    // still leak that a private agent is active on this specific task.
    // The visibility check runs in application code, so the LIMIT below is
    // applied by fetchVisibleRows only to rows that pass it — see that
    // function's doc comment for why a flat query-level .limit() cannot be
    // used here without risking a real bid being pushed out by a backlog
    // of newer hidden ones.
    const isVisible = (b: BidRow) =>
      b.tasks?.moderation_status === 'approved' && !b.tasks?.archived_at && b.agents?.profile_visibility === 'public'
    const rows = await fetchVisibleRows<BidRow>(
      (offset, pageSize) =>
        db
          .from('bids')
          .select('id, price_eur, submitted_at, tasks(title, category, moderation_status, posted_by_org_id, archived_at), agents(display_name, profile_visibility)')
          .order('submitted_at', { ascending: false })
          .range(offset, offset + pageSize - 1) as unknown as PromiseLike<{ data: BidRow[] | null; error: unknown }>,
      isVisible,
      15
    )
    const orgIds = Array.from(new Set(rows.map((b) => b.tasks?.posted_by_org_id).filter((id): id is string => !!id)))
    const seedOrgIds = await fetchSeedOrgIds(db, orgIds)
    return rows.map((b): ActivityEvent => ({
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
      // task on the public activity feed. Archived (e.g. the platform's
      // own demo tasks) is excluded the same way — see
      // frontend/sql/15_task_archival.sql.
      .eq('moderation_status', 'approved')
      .is('archived_at', null)
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
    // Same LIMIT-after-visibility requirement as recentBids above, but a
    // released transaction's visibility depends on a second, batched query
    // (its task's org/archived state) rather than an inline field — so
    // this pages the transactions table itself (via .range), and for each
    // page batch-resolves its tasks/seed-orgs before deciding which of
    // that page's rows may count, stopping as soon as 15 visible
    // completions are found or a page comes back short.
    const events: ActivityEvent[] = []
    for (let page = 0; page < FEED_MAX_PAGES && events.length < 15; page++) {
      const offset = page * FEED_PAGE_SIZE
      const { data: txPage, error: txErr } = await db
        .from('transactions')
        .select('task_id, gross_amount_eur, released_at')
        .eq('escrow_status', 'released')
        .order('released_at', { ascending: false })
        .range(offset, offset + FEED_PAGE_SIZE - 1)
      if (txErr) throw txErr
      const rows = txPage ?? []
      if (rows.length === 0) break

      const taskIds = Array.from(new Set(rows.map((r: any) => r.task_id)))
      const { data: taskRows, error: taskErr } = await db
        .from('tasks')
        .select('id, title, category, posted_by_org_id, archived_at')
        .in('id', taskIds)
      if (taskErr) throw taskErr
      const taskById = new Map((taskRows ?? []).map((t: any) => [t.id, t]))

      const orgIds = Array.from(new Set(Array.from(taskById.values()).map((t: any) => t.posted_by_org_id).filter(Boolean)))
      const seedOrgIds = await fetchSeedOrgIds(db, orgIds)

      for (const tx of rows as any[]) {
        if (events.length >= 15) break
        const task = taskById.get(tx.task_id)
        if (!task) continue // can't verify this transaction's task/org — never surface an unverifiable completion
        // Demo tasks never produce a "completed" event, full stop — not
        // even marked — a paid-completion signal is the one place a "this
        // is only a demo" caveat is not enough; it simply must not appear.
        if (task.posted_by_org_id && seedOrgIds.has(task.posted_by_org_id)) continue
        // Archived is a separate, broader exclusion — any archived task
        // (demo or not) has no business appearing as a public completion.
        if (task.archived_at) continue
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
      if (rows.length < FEED_PAGE_SIZE) break
    }
    return events
  }, [] as ActivityEvent[])

  // ── Merge + sort by time, newest first ───────────────────────────────────
  const events = [...recentBids, ...recentTasks, ...settledCompletions]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 25)

  // ── Headline stats ───────────────────────────────────────────────────────
  // tasks_total / bids_total exclude archived tasks (and their bids) the
  // same way the events feed above does — a headline count that included
  // hidden inventory while the feed and marketplace don't show any of it
  // would itself be a misleading claim. agents_active is unrelated to any
  // one task and is not affected by task archival. Only tasks_completed
  // and gmv_eur are scoped to real, released, non-demo transactions
  // specifically — see stats.metrics_scope.
  const [tasksTotal, bidsTotal, agentsTotal] = await Promise.all([
    safe(async () => (await db.from('tasks').select('id', { count: 'exact', head: true }).eq('moderation_status', 'approved').is('archived_at', null)).count ?? 0, 0),
    safe(async () => (await db.from('bids').select('id, tasks!inner(archived_at)', { count: 'exact', head: true }).is('tasks.archived_at', null)).count ?? 0, 0),
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
