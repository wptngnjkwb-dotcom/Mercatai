import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const frontendRoot = join(__dirname, '..')
const locales = ['en', 'cs', 'de', 'es'] as const

function source(relativePath: string): string {
  return readFileSync(join(frontendRoot, relativePath), 'utf8')
}

function messages(locale: typeof locales[number]): any {
  return JSON.parse(source(`messages/${locale}.json`))
}

describe('public registration consent is visible, linked, and legally coherent', () => {
  it('uses next-intl rich-text tags instead of disappearing value placeholders in every locale', () => {
    for (const locale of locales) {
      const copy = messages(locale).agentRegister.gdprConsent as string
      expect(copy, locale).toContain('<terms>')
      expect(copy, locale).toContain('</terms>')
      expect(copy, locale).toContain('<privacy>')
      expect(copy, locale).toContain('</privacy>')
      expect(copy, locale).not.toMatch(/\{terms\}|\{privacy\}/)
    }
  })

  it('renders the rich-text chunks as locale-aware Terms and Privacy links', () => {
    const page = source('app/[locale]/(agent)/agent/register/page.tsx')
    expect(page).toContain("import { Link } from '@/i18n/navigation'")
    expect(page).toMatch(/href="\/terms"[^>]*>\{chunks\}<\/Link>/)
    expect(page).toMatch(/href="\/privacy"[^>]*>\{chunks\}<\/Link>/)
  })
})

describe('payment copy distinguishes Mercatai workflow, Stripe settlement, and bank payout', () => {
  it('removes the known method-agnostic payment claims from public pages', () => {
    const publicCopy = [
      source('app/[locale]/page.tsx'),
      source('app/[locale]/ai-agents/page.tsx'),
      source('app/[locale]/developer/page.tsx'),
      ...locales.map((locale) => source(`messages/${locale}.json`)),
    ].join('\n').toLowerCase()

    for (const retired of [
      'released after buyer approval',
      'the agent gets paid only on success',
      'payment released, task done',
    ]) {
      expect(publicCopy).not.toContain(retired)
    }
  })

  it('states the real daily scheduling delay after the 48-hour review window', () => {
    for (const locale of locales) {
      const copy = messages(locale).delivery.submittedBody as string
      expect(copy, locale).toMatch(/48/)
      expect(copy, locale).toMatch(/24/)
    }
    expect(source('app/[locale]/terms/page.tsx')).toMatch(/up to 24 additional hours/i)
    expect(source('app/api/v1/openapi/route.ts')).toMatch(/daily scheduled run may take up to 24 additional hours/i)
  })

  it('keeps every homepage pricing label and disclaimer translated and non-empty', () => {
    const englishKeys = Object.keys(messages('en').home.pricingTable).sort()
    for (const locale of locales) {
      const table = messages(locale).home.pricingTable
      expect(Object.keys(table).sort(), locale).toEqual(englishKeys)
      for (const key of englishKeys) {
        expect(typeof table[key], `${locale}:${key}`).toBe('string')
        expect(table[key].trim().length, `${locale}:${key}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('privacy copy does not claim unimplemented retention or universal legal duties', () => {
  const privacy = source('app/[locale]/privacy/page.tsx')

  it('contains none of the previously unsupported absolute claims', () => {
    for (const retired of [
      /audit logs required by EU AI Act and AML/i,
      /audit logs cannot be deleted/i,
      /executed by .*AI agents.*not humans/i,
      /essential cookies required for authentication/i,
      /IP addresses in logs: anonymised after 90 days/i,
      /Stripe.*EU data centres/i,
      /Vercel.*EU region available/i,
    ]) {
      expect(privacy).not.toMatch(retired)
    }
  })

  it('accurately distinguishes browser localStorage from cookies and discloses counterparties', () => {
    expect(privacy).toMatch(/localStorage is browser storage, not a cookie/i)
    expect(privacy).toMatch(/relevant Buyer or Agent operator/i)
    expect(privacy).toMatch(/right is not absolute/i)
  })
})

describe('partial translations are disclosed instead of silently presenting English as localized copy', () => {
  it('defines non-empty notices for technical and legal pages in every locale', () => {
    for (const locale of locales) {
      const m = messages(locale)
      for (const path of [
        m.aiAgents.englishNotice,
        m.developer.englishNotice,
        m.terms.englishNotice,
        m.privacy.englishNotice,
      ]) {
        expect(typeof path, locale).toBe('string')
        expect(path.trim().length, locale).toBeGreaterThan(0)
      }
    }
  })
})
