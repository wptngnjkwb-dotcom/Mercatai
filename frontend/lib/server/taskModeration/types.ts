/**
 * Mercatai Trust & Safety Code v1 — shared types.
 *
 * The moderation decision is about content, requested conduct, and
 * distribution pattern — never about the nationality, country, language,
 * ethnicity, or religion of whoever posted the task. See policy.ts for the
 * human-readable principles this encodes and /safety for the full policy.
 */

export type ModerationDecision = 'allow' | 'allow_with_warning' | 'quarantine' | 'reject'

export type TaskModerationStatus = 'pending' | 'approved' | 'quarantined' | 'rejected'

/**
 * Stable, machine-readable reason codes. Additive-only — never remove or
 * repurpose a code once shipped, since audit rows and appeals reference
 * these by name indefinitely.
 */
export type ModerationReason =
  | 'SPAM'
  | 'PHISHING'
  | 'CREDENTIAL_HARVESTING'
  | 'WALLET_OR_TRANSACTION_REQUEST'
  | 'OFF_PLATFORM_PAYMENT'
  | 'AFFILIATE_RECRUITMENT'
  | 'EXTERNAL_ACCOUNT_CREATION'
  | 'MALWARE_OR_UNSAFE_DOWNLOAD'
  | 'TERRORIST_SUPPORT'
  | 'VIOLENT_EXTREMISM'
  | 'HATE_OR_RELIGIOUS_HARASSMENT'
  | 'POLITICAL_OR_RELIGIOUS_RECRUITMENT'
  | 'FOREIGN_INFORMATION_MANIPULATION'
  | 'SANCTIONS_EVASION'
  | 'PRIVACY_VIOLATION'
  | 'ILLEGAL_SERVICE'
  | 'PROMPT_INJECTION'
  | 'UNVERIFIABLE_DELIVERABLE'
  | 'SUSPICIOUS_EXTERNAL_LINK'

export interface ModerationInput {
  title: string
  description: string
  budgetMinEur: number
  budgetMaxEur: number
  category: string
  organizationId?: string
  organizationVerificationLevel?: string
  organizationCreatedAt?: string
}

export interface ModerationResult {
  decision: ModerationDecision
  riskScore: number
  reasonCodes: ModerationReason[]
  publicExplanation: string
  internalExplanation: string
  policyVersion: string
}

/**
 * One deterministic rule's finding. `hardFloor` forces the overall decision
 * to at least this severity regardless of the aggregate score — reserved
 * for categories the policy treats as unambiguous (see policy.ts), so a
 * single low-weight coincidental match elsewhere can't dilute them away.
 */
export interface RuleSignal {
  code: ModerationReason
  points: number
  note: string
  hardFloor?: 'quarantine' | 'reject'
}

/**
 * Interface for a future LLM-backed classifier, intentionally unimplemented
 * in v1. Deterministic rules alone cannot reliably judge intent for
 * religious-hostility, terrorism-adjacent, or influence-operation content —
 * that's why moderateTask() defaults to 'quarantine' rather than 'reject'
 * when its rules are inconclusive. A future classifier would plug in here
 * to sharpen that middle ground, not replace the deterministic floor rules.
 */
export interface TaskDraftClassifier {
  classify(input: ModerationInput): Promise<{
    reasonCodes: ModerationReason[]
    confidence: number
    notes: string
  }>
}
