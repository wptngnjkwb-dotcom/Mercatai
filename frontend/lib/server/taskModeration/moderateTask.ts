import type { ModerationDecision, ModerationInput, ModerationReason, ModerationResult, RuleSignal } from './types'
import { runAllRules } from './rules'
import { POLICY_VERSION, PUBLIC_EXPLANATIONS } from './policy'

/**
 * Mercatai Trust & Safety Code v1 — decision engine.
 *
 * KNOWN LIMITS (read before trusting this for anything beyond the MVP it
 * is): this is keyword/pattern matching, not language understanding. It
 * will miss paraphrased, translated, or novel-phrasing violations, and it
 * can be evaded by anyone who knows the trigger phrases. It has no access
 * to the network, so it cannot check whether a linked domain is actually
 * malicious, only whether the URL *looks* suspicious (shortener, bare IP).
 * Its highest-stakes categories (religious hostility, terrorism support,
 * violent extremism, foreign information manipulation) are exactly the
 * ones where a keyword system is weakest at reading intent — which is why
 * every one of those rules either hard-floors to 'quarantine' rather than
 * 'reject' when ambiguous, or requires an explicit, unambiguous action verb
 * (recruit, fundraise, incite violence) rather than firing on subject
 * matter alone. `TaskDraftClassifier` in types.ts is where a real
 * LLM-backed classifier would plug in to narrow this gap; v1 ships without
 * one on purpose (see the spec this module implements).
 */

const SEVERITY: Record<ModerationDecision, number> = {
  allow: 0,
  allow_with_warning: 1,
  quarantine: 2,
  reject: 3,
}

function moreSevere(a: ModerationDecision, b: ModerationDecision): ModerationDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b
}

function decisionFromScore(score: number): ModerationDecision {
  if (score >= 70) return 'reject'
  if (score >= 40) return 'quarantine'
  if (score >= 20) return 'allow_with_warning'
  return 'allow'
}

function combineHardFloors(signals: RuleSignal[]): ModerationDecision {
  let floor: ModerationDecision = 'allow'
  for (const s of signals) {
    if (s.hardFloor === 'reject') floor = moreSevere(floor, 'reject')
    else if (s.hardFloor === 'quarantine') floor = moreSevere(floor, 'quarantine')
  }
  return floor
}

export async function moderateTask(input: ModerationInput): Promise<ModerationResult> {
  const signals = runAllRules({
    title: input.title ?? '',
    description: input.description ?? '',
    budgetMaxEur: input.budgetMaxEur ?? 0,
  })

  const rawScore = signals.reduce((sum, s) => sum + s.points, 0)
  const riskScore = Math.max(0, Math.min(100, rawScore))

  const decision = moreSevere(decisionFromScore(riskScore), combineHardFloors(signals))

  // Unique reason codes, ordered by contributing weight (highest first) so
  // the public explanation picks the most significant one.
  const byCode = new Map<ModerationReason, number>()
  for (const s of signals) byCode.set(s.code, Math.max(byCode.get(s.code) ?? 0, s.points))
  const reasonCodes = Array.from(byCode.entries()).sort((a, b) => b[1] - a[1]).map(([code]) => code)

  const publicExplanation = decision === 'allow'
    ? 'No policy issues detected.'
    : (reasonCodes[0] ? PUBLIC_EXPLANATIONS[reasonCodes[0]] : 'This task requires manual review before it can be published.')

  const internalExplanation = signals.length === 0
    ? 'No rules triggered.'
    : signals
        .slice()
        .sort((a, b) => b.points - a.points)
        .map((s) => `[${s.code} +${s.points}] ${s.note}`)
        .join(' | ')
      + ` — total=${rawScore} (capped ${riskScore}), hardFloor=${combineHardFloors(signals)}`

  return {
    decision,
    riskScore,
    reasonCodes,
    publicExplanation,
    internalExplanation,
    policyVersion: POLICY_VERSION,
  }
}
