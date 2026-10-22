const PAGE_SIZE = 1000
const LOOKUP_CHUNK_SIZE = 200

export interface EligibleAgentReview {
  id: string
  task_id: string
  rating: number
  text: string | null
  created_at: string
}

interface OutcomeTransaction {
  id: string
  task_id: string
  escrow_status: 'released' | 'refunded'
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

/**
 * Returns only reviews backed by the agent's latest released, non-demo,
 * non-internal and non-archived task outcome. This is the shared source for
 * the public review list and the profile's rating/score summary, so an
 * internal pilot can never appear in one surface while being excluded from
 * another.
 */
export async function fetchEligibleAgentReviews(db: any, agentId: string): Promise<EligibleAgentReview[]> {
  const reviews: EligibleAgentReview[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('reviews')
      .select('id,task_id,rating,text,created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    reviews.push(...page)
    if (page.length < PAGE_SIZE) break
  }

  if (reviews.length === 0) return []

  const taskIds = Array.from(new Set(reviews.map(review => review.task_id)))
  const tasks = await fetchInChunks<{
    id: string
    posted_by_org_id: string | null
    source: string | null
    archived_at: string | null
  }>(taskIds, chunk => db
    .from('tasks')
    .select('id,posted_by_org_id,source,archived_at')
    .in('id', chunk))

  const transactions = await fetchInChunks<OutcomeTransaction>(taskIds, chunk => db
    .from('transactions')
    .select('id,task_id,escrow_status,created_at,released_at')
    .in('task_id', chunk)
    .in('escrow_status', ['released', 'refunded']))

  const organizationIds = Array.from(new Set(tasks
    .map(task => task.posted_by_org_id)
    .filter((id): id is string => !!id)))
  const organizations = await fetchInChunks<{ id: string; is_platform_seed: boolean }>(organizationIds, chunk => db
    .from('organizations')
    .select('id,is_platform_seed')
    .in('id', chunk))
  const seedOrganizationIds = new Set(organizations
    .filter(organization => organization.is_platform_seed)
    .map(organization => organization.id))

  const latestOutcomeByTask = new Map<string, { status: OutcomeTransaction['escrow_status']; at: number }>()
  for (const transaction of transactions) {
    const at = new Date(transaction.released_at ?? transaction.created_at).getTime()
    const existing = latestOutcomeByTask.get(transaction.task_id)
    if (!existing || at > existing.at) {
      latestOutcomeByTask.set(transaction.task_id, { status: transaction.escrow_status, at })
    }
  }

  const eligibleTaskIds = new Set(tasks
    .filter(task =>
      !task.archived_at
      && task.source !== 'internal_pilot'
      && (!task.posted_by_org_id || !seedOrganizationIds.has(task.posted_by_org_id))
      && latestOutcomeByTask.get(task.id)?.status === 'released'
    )
    .map(task => task.id))

  // A historical database may contain duplicate reviews for one task. Keep
  // the newest row deterministically and expose one rating observation per
  // paid task, matching computeVerifiedAgentStats.
  const latestReviewByTask = new Map<string, EligibleAgentReview>()
  for (const review of reviews) {
    if (!eligibleTaskIds.has(review.task_id)) continue
    const existing = latestReviewByTask.get(review.task_id)
    if (!existing
      || new Date(review.created_at).getTime() > new Date(existing.created_at).getTime()
      || (review.created_at === existing.created_at && review.id > existing.id)) {
      latestReviewByTask.set(review.task_id, review)
    }
  }

  return Array.from(latestReviewByTask.values()).sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    || b.id.localeCompare(a.id)
  )
}
