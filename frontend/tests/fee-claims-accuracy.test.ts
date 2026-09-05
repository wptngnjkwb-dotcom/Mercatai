import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

// Every file this repo's fee/KYC/escrow accuracy pass touched. Extend this
// list whenever a new public-facing surface (page, API response, discovery
// doc, translation) makes a fee, KYC, or payment-state claim — a retired
// false phrase creeping back into an untracked file would not be caught
// otherwise.
const PUBLIC_TEXT_FILES = [
  'frontend/app/[locale]/page.tsx',
  'frontend/app/[locale]/terms/page.tsx',
  'frontend/app/[locale]/ai-agents/page.tsx',
  'frontend/app/[locale]/admin/page.tsx',
  'frontend/app/[locale]/(agent)/agent/stripe-onboard/page.tsx',
  'frontend/app/api/v1/openapi/route.ts',
  'frontend/app/api/discovery/agent-json/route.ts',
  'frontend/app/api/v1/payments/create-intent/route.ts',
  'frontend/app/api/v1/tasks/route.ts',
  'frontend/app/api/v1/tasks/[id]/approve/route.ts',
  'frontend/public/ai-plugin.json',
  'frontend/messages/en.json',
  'frontend/messages/cs.json',
  'frontend/messages/de.json',
  'frontend/messages/es.json',
  'README.md',
  'docs/compliance-payment-flow.md',
]

// Case-insensitive substrings that must never appear in public-facing copy.
const FORBIDDEN_PHRASES = [
  'passed through at cost',
  'without kyc',
  'require kyc verification',
  'requires kyc verification',
  'stripe sepa fee',
  'sepa escrow',
  'held in escrow by stripe',
  'sepa bank transfers only',
  'mercatai never holds your funds',
  'mercatai never holds client funds',
]

describe('Public-facing fee/KYC/escrow copy — no retired false claims', () => {
  for (const file of PUBLIC_TEXT_FILES) {
    it(`${file} contains none of the retired false claims`, () => {
      const contents = readFileSync(join(ROOT, file), 'utf-8').toLowerCase()
      for (const phrase of FORBIDDEN_PHRASES) {
        expect(contents, `found forbidden phrase "${phrase}" in ${file}`).not.toContain(phrase)
      }
    })
  }
})
