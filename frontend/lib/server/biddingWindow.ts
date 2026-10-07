/**
 * Canonical server-side answer to whether a task may receive a NEW bid.
 * Missing or malformed deadlines fail closed; callers must never infer this
 * from workflow status alone because `open`/`bidding` can outlive the window.
 */
export function isBiddingWindowOpen(
  biddingClosesAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (typeof biddingClosesAt !== 'string' || biddingClosesAt.trim() === '') return false
  const closesAtMs = Date.parse(biddingClosesAt)
  return Number.isFinite(closesAtMs) && closesAtMs > nowMs
}

/** Only open/bidding workflow states can ever accept a new bid. */
export function taskAcceptsNewBids(
  task: { status: string; bidding_closes_at?: string | null },
  nowMs = Date.now(),
): boolean {
  return ['open', 'bidding'].includes(task.status)
    && isBiddingWindowOpen(task.bidding_closes_at, nowMs)
}
