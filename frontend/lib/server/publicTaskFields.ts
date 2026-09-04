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

const ESCROW_TO_FUNDING: Record<string, FundingStatus> = {
  released: 'released',
  refunded: 'refunded',
  held: 'funded',
  disputed: 'funded',
  pending: 'funding_pending',
  failed: 'unfunded',
}

export function mapEscrowStatusToFundingStatus(escrowStatus: string | null | undefined): FundingStatus {
  if (!escrowStatus) return 'unfunded'
  return ESCROW_TO_FUNDING[escrowStatus] ?? 'unfunded'
}

function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100
}

const IN_CHUNK_SIZE = 200

/** Runs `.in(...)` in bounded-size chunks so a large id list never produces an oversized query. Throws on any chunk's error. */
async function fetchInChunks<T>(
  ids: string[],
  queryFn: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const results: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CHUNK_SIZE)
    const { data, error } = await queryFn(chunk)
    if (error) throw error
    results.push(...(data ?? []))
  }
  return results
}

/**
 * Batch-resolves which of the given organization ids are the platform's own
 * seed/demo organization. Throws on any query error — a failed lookup must
 * never be silently treated as "no seed orgs found", which would let the
 * lookup failure itself mislabel real demo content as genuine.
 */
export async function fetchSeedOrgIds(db: ReturnType<typeof getSupabase>, orgIds: string[]): Promise<Set<string>> {
  if (orgIds.length === 0) return new Set()
  const rows = await fetchInChunks<{ id: string; is_platform_seed: boolean }>(orgIds, (chunk) =>
    db.from('organizations').select('id, is_platform_seed').in('id', chunk)
  )
  return new Set(rows.filter((o) => o.is_platform_seed).map((o) => o.id))
}

interface TaskWithOrg {
  id: string
  posted_by_org_id?: string | null
}

interface TransactionAttempt {
  id: string
  task_id: string
  escrow_status: string
  created_at: string
}

/**
 * Picks each task's most recent payment attempt (by created_at, tie-broken
 * deterministically by id) and returns its escrow_status — not whichever
 * status ranks "furthest along" across all of a task's rows. A task can
 * legitimately have an older 'refunded' row and a newer 'held' retry; the
 * newer attempt is the current truth regardless of what order the database
 * happens to return rows in.
 */
function pickLatestEscrowStatusPerTask(rows: TransactionAttempt[]): Map<string, string> {
  const latest = new Map<string, TransactionAttempt>()
  for (const row of rows) {
    const existing = latest.get(row.task_id)
    if (!existing) {
      latest.set(row.task_id, row)
      continue
    }
    const rowTime = new Date(row.created_at).getTime()
    const existingTime = new Date(existing.created_at).getTime()
    if (rowTime > existingTime || (rowTime === existingTime && row.id > existing.id)) {
      latest.set(row.task_id, row)
    }
  }
  const result = new Map<string, string>()
  latest.forEach((row, taskId) => result.set(taskId, row.escrow_status))
  return result
}

/**
 * Batch-derives `is_demo` and `funding_status` for a page of public tasks —
 * one organizations query and one transactions query for the whole page,
 * regardless of size, to avoid N+1. Throws on any query error rather than
 * silently defaulting — a failed lookup must never make a demo task look
 * real, or leave a task's true funding state understated or overstated.
 *
 * `is_demo` is derived only from organizations.is_platform_seed (never from
 * org/task name, description, or any client-supplied value). `posted_by_org_id`
 * itself is stripped from every returned object — only the two derived
 * fields are public.
 */
export async function attachPublicTaskFields<T extends TaskWithOrg>(
  db: ReturnType<typeof getSupabase>,
  tasks: T[]
): Promise<Array<Omit<T, 'posted_by_org_id'> & { is_demo: boolean; funding_status: FundingStatus }>> {
  if (tasks.length === 0) return []

  const taskIds = tasks.map((t) => t.id)
  const orgIds = Array.from(new Set(tasks.map((t) => t.posted_by_org_id).filter((id): id is string => !!id)))

  const [seedOrgIds, txRows] = await Promise.all([
    fetchSeedOrgIds(db, orgIds),
    fetchInChunks<TransactionAttempt>(taskIds, (chunk) =>
      db.from('transactions').select('id, task_id, escrow_status, created_at').in('task_id', chunk)
    ),
  ])

  const latestStatusByTask = pickLatestEscrowStatusPerTask(txRows)

  return tasks.map((t) => {
    const { posted_by_org_id, ...rest } = t
    return {
      ...rest,
      is_demo: !!posted_by_org_id && seedOrgIds.has(posted_by_org_id),
      funding_status: mapEscrowStatusToFundingStatus(latestStatusByTask.get(t.id)),
    } as Omit<T, 'posted_by_org_id'> & { is_demo: boolean; funding_status: FundingStatus }
  })
}

/**
 * Real, released business volume — for the public /api/v1/activity headline
 * stats. Counts a task once, using its most recently released transaction's
 * actual settled amount (never the task's posted budget), and excludes the
 * platform's own seed/demo organization. Paginates the released-transactions
 * scan deterministically rather than capping it, so revenue past any fixed
 * row limit is never silently dropped.
 *
 * Throws on any query error — the caller (GET /api/v1/activity) must fall
 * back to a safe 0/€0 rather than risk an under- or over-count built on
 * partial data.
 */
export async function computeSettledMetrics(
  db: ReturnType<typeof getSupabase>
): Promise<{ tasksCompleted: number; gmvEur: number }> {
  const PAGE_SIZE = 1000
  const releasedTx: { task_id: string; gross_amount_eur: number; released_at: string | null; created_at: string }[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('transactions')
      .select('task_id, gross_amount_eur, released_at, created_at')
      .eq('escrow_status', 'released')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data ?? []
    releasedTx.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }

  if (releasedTx.length === 0) return { tasksCompleted: 0, gmvEur: 0 }

  // Dedup: nothing stops two 'released' rows existing for one task_id (no
  // unique constraint on transactions.task_id) — keep the most recently
  // released so a task is never counted, or paid, twice.
  const byTask = new Map<string, { gross_amount_eur: number; at: number }>()
  for (const tx of releasedTx) {
    const at = new Date(tx.released_at ?? tx.created_at).getTime()
    const existing = byTask.get(tx.task_id)
    if (!existing || at > existing.at) {
      byTask.set(tx.task_id, { gross_amount_eur: Number(tx.gross_amount_eur ?? 0), at })
    }
  }

  const taskIds = Array.from(byTask.keys())
  const taskRows = await fetchInChunks<{ id: string; posted_by_org_id: string | null }>(taskIds, (chunk) =>
    db.from('tasks').select('id, posted_by_org_id').in('id', chunk)
  )
  const orgIdByTask = new Map(taskRows.map((t) => [t.id, t.posted_by_org_id]))

  const orgIds = Array.from(new Set(Array.from(orgIdByTask.values()).filter((id): id is string => !!id)))
  const seedOrgIds = await fetchSeedOrgIds(db, orgIds)

  let tasksCompleted = 0
  let gmvEur = 0
  byTask.forEach((tx, taskId) => {
    // A released transaction whose task couldn't be looked up (query
    // succeeded, but no matching row — e.g. orphaned data) can never be
    // verified as non-demo, so it must never count.
    if (!orgIdByTask.has(taskId)) return
    const orgId = orgIdByTask.get(taskId)
    if (orgId && seedOrgIds.has(orgId)) return // demo/sample task — excluded from real business metrics
    tasksCompleted += 1
    gmvEur += tx.gross_amount_eur
  })

  return { tasksCompleted, gmvEur: roundToCents(gmvEur) }
}
