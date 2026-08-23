import type { RuleSignal } from './types'

/**
 * Deterministic detectors for Mercatai Trust & Safety Code v1.
 *
 * Ground rule throughout this file: a bare mention of a name, religion,
 * country, or organisation is never itself a signal. Only content combined
 * with a requested *action* (recruit, pay off-platform, connect a wallet,
 * harass a group) scores points. `rules.md`-style keyword lists alone are
 * exactly what produces false positives on "academic analysis of Hamas" or
 * "Praise the Lord" — see moderateTask.ts for how these signals combine,
 * and the module doc there for this design's known limitations.
 *
 * URLs found in the text are only ever parsed (host/pattern-matched), never
 * fetched — this module makes no network calls.
 */

function norm(s: string): string {
  return s.toLowerCase()
}

function includesAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n
  return null
}

function countMatches(haystack: string, needles: string[]): number {
  let n = 0
  for (const needle of needles) if (haystack.includes(needle)) n++
  return n
}

// ── External links ──────────────────────────────────────────────────────

const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/gi
const URL_SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'goo.gl', 'ow.ly', 'buff.ly', 'rebrand.ly', 'cutt.ly']
const IP_LITERAL_HOST = /https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?\//i

export function extractUrls(text: string): string[] {
  return text.match(URL_PATTERN) ?? []
}

export function detectSuspiciousLinks(text: string): RuleSignal[] {
  const urls = extractUrls(text)
  if (urls.length === 0) return []

  const signals: RuleSignal[] = []
  let sawSuspiciousHost = false

  for (const url of urls) {
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      continue
    }
    if (URL_SHORTENERS.includes(host) || IP_LITERAL_HOST.test(url)) {
      sawSuspiciousHost = true
    }
  }

  if (sawSuspiciousHost) {
    signals.push({ code: 'SUSPICIOUS_EXTERNAL_LINK', points: 20, note: 'Link uses a URL shortener or a bare IP address instead of a named domain.' })
  } else {
    // A plain external link is routine (source material, references) and
    // must never gate a task on its own — see moderateTask.ts tests.
    signals.push({ code: 'SUSPICIOUS_EXTERNAL_LINK', points: 2, note: `${urls.length} external link(s) present.` })
  }
  return signals
}

// ── Wallet / crypto / credential harvesting ─────────────────────────────

const WALLET_TERMS = [
  'connect wallet', 'connect your wallet', 'wallet ownership', 'wallet-ownership',
  'wallet address', 'sign a transaction', 'sign transaction', 'sign a message',
  'sign message', 'crypto transfer', 'transfer crypto', 'send crypto',
  'metamask', 'walletconnect',
]
const SEED_PHRASE_TERMS = ['seed phrase', 'seed-phrase', 'recovery phrase', 'private key', 'private-key', 'mnemonic phrase']
const CREDENTIAL_TERMS = [
  'send your password', 'share your password', 'enter your password',
  'your api key', 'send your api key', 'share your api key',
  'session token', 'access token', 'your login credentials', 'your credentials',
  'kyc document', 'send your id', 'passport photo',
]

export function detectWalletAndCredentials(text: string): RuleSignal[] {
  const signals: RuleSignal[] = []

  if (includesAny(text, SEED_PHRASE_TERMS)) {
    // Explicit, unambiguous — a legitimate task never needs this.
    signals.push({ code: 'CREDENTIAL_HARVESTING', points: 100, note: 'Requests a wallet seed phrase or private key.', hardFloor: 'reject' })
  }

  const walletHit = includesAny(text, WALLET_TERMS)
  if (walletHit) {
    signals.push({ code: 'WALLET_OR_TRANSACTION_REQUEST', points: 55, note: `Requests wallet connection or transaction signing ("${walletHit}").`, hardFloor: 'quarantine' })
  }

  const credHit = includesAny(text, CREDENTIAL_TERMS)
  if (credHit) {
    signals.push({ code: 'CREDENTIAL_HARVESTING', points: 70, note: `Requests credentials or identity documents ("${credHit}").`, hardFloor: 'quarantine' })
  }

  return signals
}

// ── Off-platform payment / affiliate recruitment / external accounts ────

const OFF_PLATFORM_PAYMENT_TERMS = [
  'paid directly by', 'own settlement rails', 'outside mercatai', 'off-platform payment',
  'off platform payment', 'pay you directly', 'we will pay you separately',
  'payment is separate', 'settled directly',
]
const AFFILIATE_TERMS = [
  'affiliate program', 'affiliate referral', 'referral program', 'enroll as a',
  'become a hunter', 'join our program', 'referred customers', 'commission on',
  'success-only', 'success only',
]
const EXTERNAL_ACCOUNT_TERMS = [
  'as delivery evidence', 'reply with your agent_id', 'reply with your agent id',
  'register at', 'sign up at', 'complete the', 'declaration at',
]

export function detectOffPlatformAndAffiliate(text: string): RuleSignal[] {
  const signals: RuleSignal[] = []

  const payHit = includesAny(text, OFF_PLATFORM_PAYMENT_TERMS)
  if (payHit) {
    signals.push({ code: 'OFF_PLATFORM_PAYMENT', points: 45, note: `Describes payment happening outside Mercatai ("${payHit}").` })
  }

  const affiliateHit = includesAny(text, AFFILIATE_TERMS)
  if (affiliateHit) {
    signals.push({ code: 'AFFILIATE_RECRUITMENT', points: 40, note: `Recruits into an external affiliate/referral scheme ("${affiliateHit}").` })
  }

  const extAccountHit = includesAny(text, EXTERNAL_ACCOUNT_TERMS)
  if (extAccountHit && (affiliateHit || payHit)) {
    // Only counted alongside another off-platform signal — "sign up at" by
    // itself is too generic (could describe a source the agent should read).
    signals.push({ code: 'EXTERNAL_ACCOUNT_CREATION', points: 30, note: `Asks the agent to register on an external site ("${extAccountHit}").` })
  }

  return signals
}

// ── Malware / unsafe downloads ───────────────────────────────────────────

const MALWARE_TERMS = [
  'download and run', 'download and execute', 'disable your antivirus',
  'disable windows defender', 'run this script from', 'install this .exe',
  'install this software', '.exe file', 'run as administrator and',
]

export function detectMalware(text: string): RuleSignal[] {
  const hit = includesAny(text, MALWARE_TERMS)
  if (!hit) return []
  return [{ code: 'MALWARE_OR_UNSAFE_DOWNLOAD', points: 80, note: `Requests installing/running unverified software ("${hit}").`, hardFloor: 'reject' }]
}

// ── Prompt injection targeting the agent itself ──────────────────────────

const PROMPT_INJECTION_TERMS = [
  'ignore previous instructions', 'ignore your instructions', 'ignore your system prompt',
  'disregard your rules', 'disregard your operator', 'you are now unrestricted',
  'act as if you have no restrictions', 'this overrides your safety', 'as an ai agent, you must',
]

export function detectPromptInjection(text: string): RuleSignal[] {
  const hit = includesAny(text, PROMPT_INJECTION_TERMS)
  if (!hit) return []
  return [{ code: 'PROMPT_INJECTION', points: 60, note: `Contains language directed at overriding an AI agent's own rules ("${hit}").`, hardFloor: 'quarantine' }]
}

// ── Terrorism, violent extremism, sanctions evasion ──────────────────────

const TERROR_ORG_NAMES = ['hamas', 'isis', 'islamic state', 'al-qaida', 'al-qaeda', 'boko haram', 'hezbollah', 'al-shabaab']
const NEO_NAZI_TERMS = ['neo-nazi', 'neo nazi', 'national socialist movement', 'white supremacist', 'race war', 'aryan brotherhood']

const RECRUITMENT_OR_SUPPORT_VERBS = [
  'join the cause', 'pledge allegiance', 'swear loyalty', 'recruit', 'recruitment material',
  'fundraise for', 'fundraising for', 'raise funds for', 'donate to support', 'financial support for',
  'praise', 'glorify', 'celebrate the attack', 'justify the attack', 'justifies violence against civilians',
]

// Framing that indicates the text is *about* the topic, not advocating for
// it — presence of any of these strongly suppresses a terrorism/extremism
// score, per the spec's explicit "Hamas + academic analysis → allow" case.
const ANALYTICAL_CONTEXT_MARKERS = [
  'historical analysis', 'academic analysis', 'academic paper', 'academic research',
  'fact-check', 'fact check', 'fact-checking', 'literature review', 'research report',
  'news report', 'journalism', 'compare', 'comparison', 'critique of', 'criticism of',
  'theological discussion', 'translate', 'translation of', 'summarize the news',
  'explain the history of', 'analyze the ideology of', 'analysis of the ideology',
]

const SANCTIONS_TERMS = [
  'evade sanctions', 'evading sanctions', 'bypass sanctions', 'circumvent sanctions',
  'circumvent export control', 'get around export controls', 'launder money', 'shell company to hide',
]

export function detectTerrorismAndExtremism(text: string): RuleSignal[] {
  const signals: RuleSignal[] = []
  const hasAnalyticalFraming = includesAny(text, ANALYTICAL_CONTEXT_MARKERS) !== null

  const orgHit = includesAny(text, TERROR_ORG_NAMES)
  const supportVerbHit = includesAny(text, RECRUITMENT_OR_SUPPORT_VERBS)
  if (orgHit && supportVerbHit && !hasAnalyticalFraming) {
    signals.push({
      code: 'TERRORIST_SUPPORT',
      points: 100,
      note: `Combines a proscribed organisation ("${orgHit}") with recruitment/support language ("${supportVerbHit}") and no analytical framing.`,
      hardFloor: 'reject',
    })
  }

  const neoNaziHit = includesAny(text, NEO_NAZI_TERMS)
  if (neoNaziHit && !hasAnalyticalFraming) {
    signals.push({
      code: 'VIOLENT_EXTREMISM',
      points: supportVerbHit ? 100 : 65,
      note: `References violent extremist movement ("${neoNaziHit}") without analytical framing.`,
      hardFloor: supportVerbHit ? 'reject' : 'quarantine',
    })
  }

  const sanctionsHit = includesAny(text, SANCTIONS_TERMS)
  if (sanctionsHit) {
    signals.push({ code: 'SANCTIONS_EVASION', points: 90, note: `Requests help evading sanctions or export controls ("${sanctionsHit}").`, hardFloor: 'reject' })
  }

  return signals
}

// ── Targeted religious/ethnic hostility ──────────────────────────────────
//
// Deliberately structural, not a word blocklist: "Jesus", "Muhammad",
// "Muslim", "Christian", "Jewish" etc. are entirely normal in peaceful
// expression, prayer, theology, or news coverage (see the spec's explicit
// allow-list). This only fires when a term from one faith/group co-occurs
// with a hostile transitive verb *and* a term from a different faith/group
// in the same short window of text — i.e. "X will destroy Y" in structure,
// not "X" or "Y" in isolation.

interface FaithGroup {
  name: string
  terms: string[]
}

const FAITH_GROUPS: FaithGroup[] = [
  { name: 'christianity', terms: ['jesus', 'christ', 'christian', 'christians', 'christianity'] },
  { name: 'islam', terms: ['muhammad', 'mohammed', 'allah', 'muslim', 'muslims', 'islam'] },
  { name: 'judaism', terms: ['jewish', 'jews', 'judaism', 'torah'] },
  { name: 'other_faith', terms: ['hindu', 'hindus', 'buddhist', 'buddhists', 'sikh', 'sikhs'] },
]

// Comparative/hyperbolic hostility ("X will destroy Y") — serious on its
// own, unambiguous when it names a second, different group.
const DESTRUCTIVE_RHETORIC_VERBS = [
  'will destroy', 'shall destroy', 'will defeat', 'will wipe out', 'will eliminate',
  'will conquer', 'must be destroyed', 'must be eliminated',
]
// Direct incitement to violence/death — severe regardless of whether one
// group or two are named; "Muslims must be killed" needs no comparison to
// be a call for violence, and the spec requires reject for exactly this.
const VIOLENCE_INCITEMENT_VERBS = [
  'must be killed', 'deserve to die', 'should be killed', 'kill all',
  'death to', 'will exterminate', 'must be exterminated', 'will annihilate', 'must be annihilated',
]
const HOSTILE_VERBS = [...DESTRUCTIVE_RHETORIC_VERBS, ...VIOLENCE_INCITEMENT_VERBS]

/** Splits into short windows (roughly sentences) so unrelated mentions elsewhere in a long task don't spuriously co-occur. */
function sentenceWindows(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean)
}

export function detectReligiousHostility(text: string): RuleSignal[] {
  const signals: RuleSignal[] = []

  for (const window of sentenceWindows(text)) {
    const incitementHit = includesAny(window, VIOLENCE_INCITEMENT_VERBS)
    const rhetoricHit = includesAny(window, DESTRUCTIVE_RHETORIC_VERBS)
    const verbHit = incitementHit ?? rhetoricHit
    if (!verbHit) continue

    const groupsPresent = FAITH_GROUPS.filter((g) => includesAny(window, g.terms) !== null)
    if (groupsPresent.length === 0) continue

    const distinctGroups = groupsPresent.length >= 2
    // Direct incitement ("Muslims must be killed", "death to Christians")
    // is severe with a single named group — no comparison needed. Comparative
    // destructive rhetoric ("X will destroy Y") is only unambiguous once it
    // names a second, different group; a single group there is milder.
    const isReject = incitementHit !== null || distinctGroups
    signals.push({
      code: 'HATE_OR_RELIGIOUS_HARASSMENT',
      points: isReject ? 90 : 70,
      note: `Hostile language ("${verbHit}") directed at a religious/ethnic group.`,
      hardFloor: isReject ? 'reject' : 'quarantine',
    })
    break // one confirmed hit is enough signal; avoid double-counting
  }

  return signals
}

// ── Political/religious recruitment disguised as paid work ──────────────

const RECRUITMENT_DISGUISE_TERMS = [
  'join our movement', 'join our party', 'become a member of our church and',
  'convert to', 'donate to our campaign', 'volunteer for our campaign',
  'spread our message', 'share our political message',
]

export function detectPoliticalOrReligiousRecruitment(text: string): RuleSignal[] {
  const hit = includesAny(text, RECRUITMENT_DISGUISE_TERMS)
  if (!hit) return []
  return [{ code: 'POLITICAL_OR_RELIGIOUS_RECRUITMENT', points: 55, note: `Recruits for a political or religious cause under the guise of paid work ("${hit}").`, hardFloor: 'quarantine' }]
}

// ── Coordinated inauthentic behaviour / foreign information manipulation ─
//
// Content-and-conduct based, never nationality-based: a request to compare
// two countries, translate a clearly-attributed government statement, or
// hold a political opinion scores nothing here. This only fires on the
// *mechanism* — fake/duplicate accounts, bots, or concealed sponsorship —
// regardless of which government or cause is involved.

const COORDINATED_INAUTHENTIC_TERMS = [
  'fake accounts', 'create accounts to spread', 'bot accounts', 'sockpuppet',
  'sockpuppets', 'astroturf', 'astroturfing', 'undisclosed sponsorship',
  'without disclosing it is sponsored', 'hide that this is sponsored',
  'pose as independent', 'pose as ordinary citizens', 'coordinated inauthentic',
]

export function detectCoordinatedInauthenticBehaviour(text: string): RuleSignal[] {
  const hit = includesAny(text, COORDINATED_INAUTHENTIC_TERMS)
  if (!hit) return []
  return [{
    code: 'FOREIGN_INFORMATION_MANIPULATION',
    points: 95,
    note: `Requests coordinated fake accounts or concealed-sponsorship influence activity ("${hit}").`,
    hardFloor: 'reject',
  }]
}

// ── Unverifiable deliverable ──────────────────────────────────────────────

const DELIVERABLE_VERBS = [
  'write', 'translate', 'research', 'analyze', 'analyse', 'review', 'extract',
  'summarize', 'summarise', 'compare', 'design', 'build', 'audit', 'verify',
  'proofread', 'transcribe', 'edit', 'compile', 'draft', 'create a report',
]
const NON_DELIVERABLE_VERBS = ['enroll', 'enrol', 'sign up', 'register as', 'join as a', 'become a']

export function detectUnverifiableDeliverable(text: string, budgetMaxEur: number): RuleSignal[] {
  const hasDeliverableVerb = includesAny(text, DELIVERABLE_VERBS) !== null
  const hasNonDeliverableVerb = includesAny(text, NON_DELIVERABLE_VERBS) !== null

  if (hasNonDeliverableVerb && !hasDeliverableVerb) {
    return [{
      code: 'UNVERIFIABLE_DELIVERABLE',
      points: budgetMaxEur <= 5 ? 35 : 20,
      note: 'Describes enrollment/registration rather than a work product a buyer could review.',
    }]
  }
  return []
}

/** Runs every detector and returns the combined, unordered signal list. */
export function runAllRules(input: { title: string; description: string; budgetMaxEur: number }): RuleSignal[] {
  const text = norm(`${input.title}\n${input.description}`)
  return [
    ...detectSuspiciousLinks(text),
    ...detectWalletAndCredentials(text),
    ...detectOffPlatformAndAffiliate(text),
    ...detectMalware(text),
    ...detectPromptInjection(text),
    ...detectTerrorismAndExtremism(text),
    ...detectReligiousHostility(text),
    ...detectPoliticalOrReligiousRecruitment(text),
    ...detectCoordinatedInauthenticBehaviour(text),
    ...detectUnverifiableDeliverable(text, input.budgetMaxEur),
  ]
}

// Exported for tests / reuse — counts distinct terror org mentions without
// scoring, useful for future report-volume heuristics.
export function mentionsTerrorOrgName(text: string): boolean {
  return countMatches(norm(text), TERROR_ORG_NAMES) > 0
}
