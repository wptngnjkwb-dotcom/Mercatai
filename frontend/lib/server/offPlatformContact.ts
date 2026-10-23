export type OffPlatformContactReason =
  | 'EMAIL_ADDRESS'
  | 'PHONE_NUMBER'
  | 'MESSAGING_CONTACT'
  | 'EXTERNAL_URL'
  | 'PAYMENT_HANDLE'
  | 'CRYPTO_ADDRESS'

export interface OffPlatformContactFinding {
  blocked: boolean
  reasonCodes: OffPlatformContactReason[]
}

export interface OffPlatformContactOptions {
  /**
   * Public agent surfaces and pre-funding offers must not advertise an
   * external destination. Task briefs may still contain source material,
   * so their ordinary research URLs remain allowed while direct contact,
   * payment and messaging destinations are blocked.
   */
  blockExternalUrls?: boolean
}

const EMAIL_PATTERN = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i
const OBFUSCATED_EMAIL_PATTERN = /\b[a-z0-9._%+-]+\s*(?:\[at\]|\(at\)|\sat\s)\s*[a-z0-9.-]+\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*[a-z]{2,}\b/i

// A leading + makes a long digit sequence unambiguously contact-like. Bare
// numbers are only treated as phones when accompanied by a contact verb or
// label, avoiding false positives on order numbers, prices and task IDs.
const INTERNATIONAL_PHONE_PATTERN = /(?:^|[^\w])\+(?:[\s().-]*\d){8,15}(?:$|[^\w])/i
const PHONE_CONTEXT_PATTERN = /\b(?:call|phone|telephone|mobile|text|sms|whats?app|telefon|volejte|zavolejte|telefono|teléfono|llama|anrufen|handy)\b[^\n]{0,32}?(?:\d[\s().-]*){7,15}/i

const MESSAGING_PATTERN = /(?:\b(?:t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|signal\.me|discord\.gg|discord\.com\/invite)\/|\b(?:telegram|whats?app|signal|wechat|discord)\b[^\n]{0,32}@?[a-z0-9_.+-]{3,})/i

const PAYMENT_HANDLE_PATTERN = /(?:\b(?:paypal\.me|revolut\.me|cash\.app|venmo\.com\/u|wise\.com\/pay)\/|\b(?:pay|send|transfer)\b[^\n]{0,40}\b(?:paypal|revolut|cash\s*app|venmo|wise)\b)/i

const CRYPTO_PATTERNS = [
  /\b0x[a-f0-9]{40}\b/i, // Ethereum/EVM
  /\bbc1[ac-hj-np-z02-9]{25,90}\b/i, // Bitcoin bech32
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/, // Bitcoin base58
  /\bT[a-km-zA-HJ-NP-Z1-9]{33}\b/, // TRON
]

const EXPLICIT_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi
const BARE_DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|eu|cz|de|es|co|me|dev|app|xyz|online|site|info)(?:\/[^\s<>"')\]]*)?/gi

function externalUrls(text: string): string[] {
  const candidates = [...(text.match(EXPLICIT_URL_PATTERN) ?? []), ...(text.match(BARE_DOMAIN_PATTERN) ?? [])]
  return candidates.filter((candidate) => {
    const normalized = /^https?:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate.replace(/^www\./i, '')}`
    try {
      const host = new URL(normalized).hostname.toLowerCase().replace(/^www\./, '')
      return host !== 'mercatai.eu' && !host.endsWith('.mercatai.eu')
    } catch {
      // A string that matched a URL pattern but cannot be parsed should not
      // become a bypass merely because it is malformed.
      return true
    }
  })
}

/**
 * Detect direct-contact and external-payment coordinates without returning
 * the matched value. Callers may safely audit reasonCodes; they must never
 * log the submitted text or a regex match because it can contain PII.
 */
export function detectOffPlatformContact(
  values: Array<string | null | undefined>,
  options: OffPlatformContactOptions = {},
): OffPlatformContactFinding {
  const text = values.filter((value): value is string => typeof value === 'string').join('\n')
  const reasons = new Set<OffPlatformContactReason>()

  if (EMAIL_PATTERN.test(text) || OBFUSCATED_EMAIL_PATTERN.test(text)) reasons.add('EMAIL_ADDRESS')
  if (INTERNATIONAL_PHONE_PATTERN.test(text) || PHONE_CONTEXT_PATTERN.test(text)) reasons.add('PHONE_NUMBER')
  if (MESSAGING_PATTERN.test(text)) reasons.add('MESSAGING_CONTACT')
  if (PAYMENT_HANDLE_PATTERN.test(text)) reasons.add('PAYMENT_HANDLE')
  if (CRYPTO_PATTERNS.some((pattern) => pattern.test(text))) reasons.add('CRYPTO_ADDRESS')
  if (options.blockExternalUrls && externalUrls(text).length > 0) reasons.add('EXTERNAL_URL')

  const reasonCodes = Array.from(reasons)
  return { blocked: reasonCodes.length > 0, reasonCodes }
}

export function offPlatformContactError(finding: OffPlatformContactFinding) {
  return {
    error: 'Direct contact details, external payment coordinates and off-platform messaging links are not allowed here. Keep communication and payment inside Mercatai.',
    code: 'off_platform_contact_not_allowed',
    reason_codes: finding.reasonCodes,
    policy_url: 'https://mercatai.eu/terms#off-platform-contact',
  }
}
