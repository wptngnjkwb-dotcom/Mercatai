import { getSupabase } from '@/lib/server/supabase'

/**
 * Public, buyer-facing funding state. Deliberately not a 1:1 mirror of
 * `transactions.escrow_status` — 'failed' and the currently-unused
 * 'disputed' collapse into whichever of these five best represents what a
 * task's actual money situation looks like from the outside: 'disputed'
 * still means funds are held pending resolution ('funded'); a lone
 * 'failed' attempt means no money ever actually landed ('unfunded').
 */
export type FundingStatus = 'unfunded' | 'funding_pending' | 'funded' | 'released' | 'refunded'

/**
 * Priority order for picking the one funding_status that represents a task
 * with more than one transactions row (retried/replaced payment attempts —
 * there is no DB constraint against this, see transactions.task_id). Higher
 * rank wins when a task has rows in more than one state.
 */
const ESCROW_TO_FUNDING: Record<string, { status: FundingStatus; rank: number }> = {
  released: { status: 'released', rank: 5 },
  refunded: { status: 'refunded', rank: 4 },
  held: { status: 'funded', rank: 3 },
  disputed: { status: 'funded', rank: 3 },
  pending: { status: 'funding_pending', rank: 2 },
  failed: { status: 'unfunded', rank: 1 },
}

export function mapEscrowStatusToFundingStatus(escrowStatus: string | null | undefined): FundingStatus {
  if (!escrowStatus) return 'unfunded'
  return ESCROW_TO_FUNDING[escrowStatus]?.status ?? 'unfunded'
}

interface TaskWithOrg {
  id: string
  posted_by_org_id?: string | null
}

/**
 * Batch-derives `is_demo` and `funding_status` for a page of public tasks —
 * exactly one `organizations` query and one `transactions` query for the
 * whole page, regardless of how many tasks are in it, to avoid N+1.
 *
 * `is_demo` is derived only from `organizations.is_platform_seed` (never
 * from org/task name, description, or any client-supplied value — that
 * column is only ever set by trusted seed/migration scripts, see its
 * comment in backend/db/schema.sql). Only the boolean itself is returned;
 * no organization field is exposed, and `posted_by_org_id` must be dropped
 * by the caller before this reaches a public response.
 */
export async function attachPublicTaskFields<T extends TaskWithOrg>(
  db: ReturnType<typeof getSupabase>,
  tasks: T[]
): Promise<Array<T & { is_demo: boolean; funding_status: FundingStatus }>> {
  if (tasks.length === 0) return []

  const taskIds = tasks.map((t) => t.id)
  const orgIds = Array.from(new Set(tasks.map((t) => t.posted_by_org_id).filter((id): id is string => !!id)))

  const [orgRes, txRes] = await Promise.all([
    orgIds.length
      ? db.from('organizations').select('id, is_platform_seed').in('id', orgIds)
      : Promise.resolve({ data: [] as { id: string; is_platform_seed: boolean }[] }),
    db.from('transactions').select('task_id, escrow_status').in('task_id', taskIds),
  ])

  const seedOrgIds = new Set((orgRes.data ?? []).filter((o: any) => o.is_platform_seed).map((o: any) => o.id))

  const bestByTask = new Map<string, string>()
  const bestRank = new Map<string, number>()
  for (const tx of (txRes.data ?? []) as { task_id: string; escrow_status: string }[]) {
    const entry = ESCROW_TO_FUNDING[tx.escrow_status]
    const rank = entry?.rank ?? 0
    if (rank > (bestRank.get(tx.task_id) ?? -1)) {
      bestRank.set(tx.task_id, rank)
      bestByTask.set(tx.task_id, tx.escrow_status)
    }
  }

  return tasks.map((t) => ({
    ...t,
    is_demo: !!t.posted_by_org_id && seedOrgIds.has(t.posted_by_org_id),
    funding_status: mapEscrowStatusToFundingStatus(bestByTask.get(t.id)),
  }))
}

/**
 * Real, released business volume — for the public /api/v1/activity headline
 * stats. Counts a task once, using its actual settled transaction amount,
 * never the task's posted budget, and excludes the platform's own seed/demo
 * organization so sample briefs never inflate real numbers.
 */
export async function computeSettledMetrics(
  db: ReturnType<typeof getSupabase>
): Promise<{ tasksCompleted: number; gmvEur: number }> {
  const { data: releasedTx } = await db
    .from('transactions')
    .select('task_id, gross_amount_eur, released_at, created_at')
    .eq('escrow_status', 'released')
    .limit(1000)

  const rows = (releasedTx ?? []) as { task_id: string; gross_amount_eur: number; released_at: string | null; created_at: string }[]
  if (rows.length === 0) return { tasksCompleted: 0, gmvEur: 0 }

  // Dedup: nothing stops two 'released' rows existing for one task_id
  // (no unique constraint on transactions.task_id) — keep the most
  // recently released so a task is never counted, or paid, twice.
  const byTask = new Map<string, { gross_amount_eur: number; at: number }>()
  for (const tx of rows) {
    const at = new Date(tx.released_at ?? tx.created_at).getTime()
    const existing = byTask.get(tx.task_id)
    if (!existing || at > existing.at) {
      byTask.set(tx.task_id, { gross_amount_eur: Number(tx.gross_amount_eur ?? 0), at })
    }
  }

  const taskIds = Array.from(byTask.keys())
  const { data: taskRows } = await db
    .from('tasks')
    .select('id, posted_by_org_id')
    .in('id', taskIds)
  const orgIdByTask = new Map((taskRows ?? []).map((t: any) => [t.id, t.posted_by_org_id]))

  const orgIds = Array.from(new Set(Array.from(orgIdByTask.values()).filter(Boolean))) as string[]
  const { data: orgRows } = orgIds.length
    ? await db.from('organizations').select('id, is_platform_seed').in('id', orgIds)
    : { data: [] as { id: string; is_platform_seed: boolean }[] }
  const seedOrgIds = new Set((orgRows ?? []).filter((o: any) => o.is_platform_seed).map((o: any) => o.id))

  let tasksCompleted = 0
  let gmvEur = 0
  byTask.forEach((tx, taskId) => {
    const orgId = orgIdByTask.get(taskId)
    if (orgId && seedOrgIds.has(orgId)) return // demo/sample task — excluded from real business metrics
    tasksCompleted += 1
    gmvEur += tx.gross_amount_eur
  })

  return { tasksCompleted, gmvEur }
}
