/**
 * Mercatai Score — a single, transparent 0–100 trust number per agent.
 *
 * Unlike the raw `reputation_score` (which only moves on reputation events),
 * the Mercatai Score blends every trust signal we have into one citable figure
 * with a visible breakdown. It is non-transferable — an agent can only grow it
 * by performing on Mercatai, which is the core of the marketplace's moat.
 *
 * Pure function — no I/O, safe to call anywhere (server or via API enrichment).
 */

export interface ScoreInputs {
  reputation_score?: number | null      // 0–100, from reputation events
  success_rate?: number | null          // 0.0–1.0
  total_tasks_completed?: number | null
  avg_rating?: number | null            // 1–5
  review_count?: number | null
  verification_level?: string | null    // 'anonymous' | 'email' | 'verified' | ...
  stripe_onboarding_completed?: boolean | null
}

export interface ScoreComponent {
  key: string
  label: string
  /** This component's earned points, out of `max`. */
  points: number
  max: number
}

export interface MercataiScore {
  score: number          // 0–100, rounded
  grade: string          // 'A+' | 'A' | 'B' | 'C' | 'D'
  label: string          // 'Elite' | 'Trusted' | 'Established' | 'Developing' | 'New'
  components: ScoreComponent[]
}

// Component weights (must sum to 100)
const W_REPUTATION = 35
const W_SUCCESS = 25
const W_VOLUME = 15
const W_RATINGS = 15
const W_VERIFIED = 10

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

/** Volume factor — log-scaled so the first jobs matter most, saturates ~100 tasks. */
function volumeFactor(tasks: number): number {
  if (tasks <= 0) return 0
  return clamp01(Math.log10(tasks + 1) / 2) // log10(101) ≈ 2.0 → 1.0
}

/** Ratings factor — average rating discounted by review-count confidence. */
function ratingsFactor(avg: number | null | undefined, count: number | null | undefined): number {
  const a = avg ?? 0
  const c = count ?? 0
  if (a <= 0 || c <= 0) return 0
  const normalized = clamp01((a - 1) / 4)            // map 1–5 → 0–1
  const confidence = clamp01(c / 10)                  // full confidence at 10+ reviews
  return normalized * confidence
}

function verifiedFactor(level: string | null | undefined, stripe: boolean | null | undefined): number {
  let f = 0
  if (level === 'verified' || level === 'kyc') f += 0.6
  else if (level === 'email') f += 0.3
  if (stripe) f += 0.4
  return clamp01(f)
}

function gradeFor(score: number): { grade: string; label: string } {
  if (score >= 90) return { grade: 'A+', label: 'Elite' }
  if (score >= 80) return { grade: 'A', label: 'Trusted' }
  if (score >= 65) return { grade: 'B', label: 'Established' }
  if (score >= 45) return { grade: 'C', label: 'Developing' }
  return { grade: 'D', label: 'New' }
}

export function computeMercataiScore(input: ScoreInputs): MercataiScore {
  const repF = clamp01((input.reputation_score ?? 50) / 100)
  const succF = clamp01(input.success_rate ?? 0)
  const volF = volumeFactor(input.total_tasks_completed ?? 0)
  const ratF = ratingsFactor(input.avg_rating, input.review_count)
  const verF = verifiedFactor(input.verification_level, input.stripe_onboarding_completed)

  const components: ScoreComponent[] = [
    { key: 'reputation', label: 'Reputation',   points: round1(repF * W_REPUTATION),  max: W_REPUTATION },
    { key: 'success',    label: 'Success rate',  points: round1(succF * W_SUCCESS),    max: W_SUCCESS },
    { key: 'volume',     label: 'Track record',  points: round1(volF * W_VOLUME),      max: W_VOLUME },
    { key: 'ratings',    label: 'Buyer ratings', points: round1(ratF * W_RATINGS),     max: W_RATINGS },
    { key: 'verified',   label: 'Verification',  points: round1(verF * W_VERIFIED),    max: W_VERIFIED },
  ]

  const score = Math.round(components.reduce((s, c) => s + c.points, 0))
  const { grade, label } = gradeFor(score)
  return { score, grade, label, components }
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}
