import * as Sentry from '@sentry/nextjs'

const PAGE_SIZE = 1000
const LOOKUP_CHUNK_SIZE = 200
const RATING_DATA_UNAVAILABLE_MESSAGE = 'Verified agent rating data is unavailable'

// A permanently missing legacy reviews table must not consume one Sentry
// event per profile view. Serverless cold starts may each emit once, while a
// long-running self-host process emits at most once until restart.
let ratingDataUnavailableReported = false

function reportRatingDataUnavailable() {
  if (ratingDataUnavailableReported) return
  ratingDataUnavailableReported = true
  console.error(RATING_DATA_UNAVAILABLE_MESSAGE)
  Sentry.captureMessage(RATING_DATA_UNAVAILABLE_MESSAGE, 'warning')
}

type OutcomeStatus = 'released' | 'refunded'

interface OutcomeTransaction {
  id: string
  task_id: string
  escrow_status: OutcomeStatus
  created_at: string
  released_at: string | null
}

async function fetchInChunks<T>(
  ids: string[],
  fetcher: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let index = 0; index < ids.length; index += LOOKUP_CHUNK_SIZE) {
    const { data, error } = await fetcher(ids.slice(index, index + LOOKUP_CHUNK_SIZE))
    if (error) throw error
    rows.push(...(data ?? []))
  }
  return rows
}

export interface VerifiedAgentStats {
  metrics_scope: 'released_or_refunded_non_demo_transactions'
  paid_tasks_completed: number
  refunded_tasks: number
  outcome_sample_size: number
  release_rate: number | null
  ratings_available: boolean
  rated_tasks: number
  average_rating: number | null
  completed_by_category: Array<{ category: string; count: number }>
}

/**
 * Computes public outcome evidence from payment state, never from mutable
 * agent profile counters. No task ids or buyer identities leave this helper.
 */
export async function computeVerifiedAgentStats(db: any, agentId: string): Promise<VerifiedAgentStats> {
  const transactions: OutcomeTransaction[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('transactions')
      .select('id,task_id,escrow_status,created_at,released_at')
      .eq('agent_id', agentId)
      .in('escrow_status', ['released', 'refunded'])
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    transactions.push(...page)
    if (page.length < PAGE_SIZE) break
  }

  if (transactions.length === 0) return emptyStats()

  // Multiple attempts may exist for one task. Keep the latest terminal
  // payment outcome and count the business task only once.
  const latestByTask = new Map<string, { status: OutcomeStatus; at: number }>()
  for (const transaction of transactions) {
    const at = new Date(transaction.released_at ?? transaction.created_at).getTime()
    const existing = latestByTask.get(transaction.task_id)
    if (!existing || at > existing.at) {
      latestByTask.set(transaction.task_id, { status: transaction.escrow_status, at })
    }
  }

  const taskIds = Array.from(latestByTask.keys())
  const tasks = await fetchInChunks<{
    id: string
    category: string | null
    posted_by_org_id: string | null
    source: string | null
    archived_at: string | null
  }>(taskIds, chunk => db
    .from('tasks')
    .select('id,category,posted_by_org_id,source,archived_at')
    .in('id', chunk))

  const orgIds = Array.from(new Set(tasks.map(task => task.posted_by_org_id).filter((id): id is string => !!id)))
  const organizations = await fetchInChunks<{ id: string; is_platform_seed: boolean }>(orgIds, chunk => db
    .from('organizations')
    .select('id,is_platform_seed')
    .in('id', chunk))
  const seedOrganizations = new Set(organizations.filter(org => org.is_platform_seed).map(org => org.id))

  const eligibleTasks = tasks.filter(task =>
    !task.archived_at
    && task.source !== 'internal_pilot'
    && (!task.posted_by_org_id || !seedOrganizations.has(task.posted_by_org_id))
  )
  const eligibleIds = eligibleTasks.map(task => task.id)
  if (eligibleIds.length === 0) return emptyStats()

  const releasedIds = eligibleTasks
    .filter(task => latestByTask.get(task.id)?.status === 'released')
    .map(task => task.id)
  const paidTasksCompleted = releasedIds.length
  const refundedTasks = eligibleTasks.filter(task => latestByTask.get(task.id)?.status === 'refunded').length
  const outcomeSampleSize = paidTasksCompleted + refundedTasks

  let ratingsAvailable = true
  let reviews: Array<{ id: string; task_id: string; rating: number; created_at: string }> = []
  try {
    reviews = await fetchInChunks<{ id: string; task_id: string; rating: number; created_at: string }>(releasedIds, chunk => db
      .from('reviews')
      .select('id,task_id,rating,created_at')
      .eq('agent_id', agentId)
      .in('task_id', chunk))
  } catch {
    // Reviews are an optional legacy subsystem on older self-host installs.
    // Keep payment-backed outcomes available, but mark rating evidence as
    // unavailable instead of silently presenting zero or failing the whole
    // profile. Other required outcome queries still fail closed.
    reportRatingDataUnavailable()
    ratingsAvailable = false
  }

  const categoryCounts = new Map<string, number>()
  for (const task of eligibleTasks) {
    if (latestByTask.get(task.id)?.status !== 'released') continue
    const category = task.category ?? 'uncategorized'
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  }
  // Historical databases may lack the intended one-review-per-task
  // constraint. A task is one rating observation regardless of duplicate
  // rows; retain the newest row deterministically.
  const latestReviewByTask = new Map<string, { id: string; rating: number; at: number }>()
  for (const review of reviews) {
    const at = new Date(review.created_at).getTime()
    const existing = latestReviewByTask.get(review.task_id)
    if (!existing || at > existing.at || (at === existing.at && review.id > existing.id)) {
      latestReviewByTask.set(review.task_id, { id: review.id, rating: Number(review.rating), at })
    }
  }
  const uniqueReviews = Array.from(latestReviewByTask.values())
  const ratingSum = uniqueReviews.reduce((sum, review) => sum + review.rating, 0)

  return {
    metrics_scope: 'released_or_refunded_non_demo_transactions',
    paid_tasks_completed: paidTasksCompleted,
    refunded_tasks: refundedTasks,
    outcome_sample_size: outcomeSampleSize,
    release_rate: outcomeSampleSize > 0 ? round(paidTasksCompleted / outcomeSampleSize, 4) : null,
    ratings_available: ratingsAvailable,
    rated_tasks: uniqueReviews.length,
    average_rating: uniqueReviews.length > 0 ? round(ratingSum / uniqueReviews.length, 1) : null,
    completed_by_category: Array.from(categoryCounts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
  }
}

function emptyStats(): VerifiedAgentStats {
  return {
    metrics_scope: 'released_or_refunded_non_demo_transactions',
    paid_tasks_completed: 0,
    refunded_tasks: 0,
    outcome_sample_size: 0,
    release_rate: null,
    ratings_available: true,
    rated_tasks: 0,
    average_rating: null,
    completed_by_category: [],
  }
}

function round(value: number, decimals: number) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
