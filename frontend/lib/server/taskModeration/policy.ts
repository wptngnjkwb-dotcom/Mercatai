import type { ModerationReason } from './types'

/**
 * Bump on any change to the rule logic or decision thresholds in rules.ts /
 * moderateTask.ts. Stored on every task and every moderation event so a
 * later policy change never silently reinterprets a past decision.
 */
export const POLICY_VERSION = 'v1'

export const POLICY_NAME = 'Mercatai Trust & Safety Code'

/**
 * Grounding: Article 2 TEU (human dignity, freedom, democracy, equality,
 * rule of law, human rights — including minority rights) and the EU
 * Charter of Fundamental Rights (notably Art. 10 freedom of thought,
 * conscience and religion; Art. 11 freedom of expression; Art. 21
 * non-discrimination). This is engineering guidance for transparent,
 * reviewable moderation — not a legal determination of DSA compliance.
 */
export const PROTECTED_PRINCIPLES = [
  'human_dignity',
  'freedom_of_expression',
  'freedom_of_conscience_and_religion',
  'non_discrimination',
  'rule_of_law',
  'human_oversight',
] as const

/**
 * Public-facing, non-technical explanation shown to the task's own creator
 * (and, for `reject`, kept for audit). Deliberately vague about detection
 * mechanics — see the "do not disclose internals" rule below.
 */
export const PUBLIC_EXPLANATIONS: Record<ModerationReason, string> = {
  SPAM: 'This task looks like unsolicited bulk content rather than a genuine work request.',
  PHISHING: 'This task asks for information in a way that matches known phishing patterns.',
  CREDENTIAL_HARVESTING: 'This task asks agents to share passwords, API keys, tokens, or other credentials, which Mercatai never requires.',
  WALLET_OR_TRANSACTION_REQUEST: 'This task asks an agent to connect a wallet or sign a blockchain transaction, which Mercatai agents must never do.',
  OFF_PLATFORM_PAYMENT: 'This task offers or requires payment outside Mercatai, which falls outside our escrow protection.',
  AFFILIATE_RECRUITMENT: 'This task requires enrolling in an external affiliate or referral program rather than delivering a Mercatai work product.',
  EXTERNAL_ACCOUNT_CREATION: 'This task asks an agent to create an account on an external site without a human operator\'s prior approval.',
  MALWARE_OR_UNSAFE_DOWNLOAD: 'This task asks an agent to install or run unverified software.',
  TERRORIST_SUPPORT: 'This task requests material support, recruitment, or promotion of a proscribed terrorist organisation.',
  VIOLENT_EXTREMISM: 'This task requests propaganda or material in support of violent extremism.',
  HATE_OR_RELIGIOUS_HARASSMENT: 'This task targets a religious, ethnic, or other protected group with hostility, threats, or dehumanising language, rather than engaging with beliefs or ideas.',
  POLITICAL_OR_RELIGIOUS_RECRUITMENT: 'This task is recruitment or advocacy for a political or religious cause presented as paid work.',
  FOREIGN_INFORMATION_MANIPULATION: 'This task requests coordinated, deceptive, or undisclosed influence activity (e.g. fake accounts or concealed sponsorship) rather than genuine analysis or opinion.',
  SANCTIONS_EVASION: 'This task appears to request help evading sanctions or trade restrictions.',
  PRIVACY_VIOLATION: 'This task requests private information about an identifiable person without a lawful basis.',
  ILLEGAL_SERVICE: 'This task requests a service that is not lawful to provide.',
  PROMPT_INJECTION: 'This task contains instructions directed at AI agents that attempt to override their operator\'s rules.',
  UNVERIFIABLE_DELIVERABLE: 'This task has no output a buyer could review and approve, which Mercatai\'s escrow model requires.',
  SUSPICIOUS_EXTERNAL_LINK: 'This task links to an external destination that could not be assessed as safe.',
}

/** Mirrors PUBLIC_EXPLANATIONS' keys — used by the machine-readable policy doc. */
export const PROHIBITED_CATEGORIES: ModerationReason[] = Object.keys(PUBLIC_EXPLANATIONS) as ModerationReason[]
