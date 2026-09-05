import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const REPO_ROOT = join(__dirname, '..', '..')

// A prior version of this test scanned a hand-picked list of files — which
// is exactly how "EU AI Act compliant" / "GDPR compliant" survived in
// frontend/app/[locale]/privacy/page.tsx, layout.tsx, and elsewhere despite
// an earlier fee/KYC/escrow pass. This version walks the actual repo tree
// instead, so a stale claim in a file nobody thought to list can't hide.
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel', '.claude',
  '__pycache__', '.venv', 'venv',
  // Test directories: these legitimately contain the forbidden phrases
  // themselves (as strings being asserted against), including this file.
  'tests', 'test', '__tests__',
  // backend/ is confirmed dead/undeployed code (see the notice at the top
  // of backend/main.py) — it is deliberately left un-rewritten rather than
  // kept in sync with the live product, so it is out of scope for this
  // live-surface sweep rather than silently exempt.
  'backend',
])
const INCLUDED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.mdx', '.json', '.yml', '.yaml', '.sql'])
const EXCLUDED_FILES = new Set(['package-lock.json'])
const MAX_FILE_SIZE = 2_000_000 // skip oversized (generated/lockfile-like) files defensively

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_FILES.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) walk(full, files)
    } else if (INCLUDED_EXTENSIONS.has(extname(entry)) && stat.size <= MAX_FILE_SIZE) {
      files.push(full)
    }
  }
  return files
}

// Case-insensitive substrings that must never appear in live, public-facing
// copy (or in code comments/docs that describe it).
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
  'mercatai never holds your money',
  'sepa_bank_transfer',
  'first 10 tasks free',
  'first 10 tasks are free',
  'tasks free for every agent',
  'eu ai act compliant',
  'eu ai act compliance',
  'gdpr compliant',
  'ki-act-konform',
  'conforme al reglamento de ia',
  'in compliance with the eu ai act',
  // The old claim tied card authorization to bid acceptance and applied a
  // single release-gated model to both payment methods, which doesn't hold
  // for SEPA Direct Debit under the destination-charge model in use.
  'authorized via stripe when you accept a bid',
  'autorizována přes stripe při přijetí nabídky',
  'wird per stripe autorisiert, wenn sie ein gebot annehmen',
  'se autoriza vía stripe al aceptar una puja',
  "outside mercatai's escrow",
  'mimo úschovu mercatai',
  'treuhandsystems von mercatai',
  'sistema de custodia de mercatai',
]

const files = walk(REPO_ROOT)

describe('Whole-repo sweep — no retired false fee/KYC/escrow/compliance claims', () => {
  // A misconfigured exclude/include list could silently make the sweep
  // below vacuously pass over almost nothing — this guards against that.
  it('scans a realistic number of files across the repo', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  for (const phrase of FORBIDDEN_PHRASES) {
    it(`no file in the repo contains "${phrase}"`, () => {
      const offenders: string[] = []
      for (const file of files) {
        const contents = readFileSync(file, 'utf-8').toLowerCase()
        if (contents.includes(phrase)) offenders.push(file.replace(REPO_ROOT + '/', ''))
      }
      expect(offenders, `files containing "${phrase}": ${offenders.join(', ')}`).toEqual([])
    })
  }
})
