import { describe, expect, it } from 'vitest'
import { detectOffPlatformContact, offPlatformContactError } from '@/lib/server/offPlatformContact'

describe('off-platform contact detector', () => {
  it.each([
    ['email', 'Email me at human@example.com', 'EMAIL_ADDRESS'],
    ['obfuscated email', 'Write to human [at] example [dot] com', 'EMAIL_ADDRESS'],
    ['international phone', 'Call me at +420 777 123 456', 'PHONE_NUMBER'],
    ['contextual local phone', 'Telefon: 777 123 456', 'PHONE_NUMBER'],
    ['Telegram', 'Contact me on Telegram @outside_agent', 'MESSAGING_CONTACT'],
    ['WhatsApp link', 'Continue at wa.me/420777123456', 'MESSAGING_CONTACT'],
    ['payment handle', 'Pay me through paypal.me/outside', 'PAYMENT_HANDLE'],
    ['Ethereum address', 'Send payment to 0x0123456789abcdef0123456789abcdef01234567', 'CRYPTO_ADDRESS'],
    ['Bitcoin address', 'Use bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'CRYPTO_ADDRESS'],
  ])('blocks %s without returning the matched value', (_label, text, reason) => {
    const finding = detectOffPlatformContact([text])
    expect(finding).toMatchObject({ blocked: true, reasonCodes: expect.arrayContaining([reason]) })
    expect(JSON.stringify(offPlatformContactError(finding))).not.toContain(text)
  })

  it('allows an ordinary source URL in a task brief', () => {
    expect(detectOffPlatformContact([
      'Compare pricing at https://example.com/pricing and cite the public source.',
    ])).toEqual({ blocked: false, reasonCodes: [] })
  })

  it('blocks the same external URL on a public profile or pre-funding offer', () => {
    expect(detectOffPlatformContact([
      'Portfolio: https://example.com/my-work',
    ], { blockExternalUrls: true })).toEqual({ blocked: true, reasonCodes: ['EXTERNAL_URL'] })
  })

  it('does not block Mercatai links when external URLs are forbidden', () => {
    expect(detectOffPlatformContact([
      'See https://www.mercatai.eu/terms and mercatai.eu/safety.',
    ], { blockExternalUrls: true })).toEqual({ blocked: false, reasonCodes: [] })
  })

  it('does not mistake ordinary prices, dates or identifiers for phone numbers', () => {
    expect(detectOffPlatformContact([
      'Budget €1234.50, deadline 2026-11-30, order 123456789 and task 97c6d67.',
    ])).toEqual({ blocked: false, reasonCodes: [] })
  })

  it('deduplicates reason codes across multiple submitted fields', () => {
    expect(detectOffPlatformContact([
      'human@example.com',
      'Backup: other@example.net',
    ])).toEqual({ blocked: true, reasonCodes: ['EMAIL_ADDRESS'] })
  })
})
