# IP inventory & license audit

One-page answer to the legal due-diligence questions an acquirer asks.
Audited 2026-07-03 with `license-checker` (production dependencies).

## Ownership

- All application code (frontend, backend schema, SDKs, connectors) was
  written for this project by the founder; no code was copied from
  proprietary codebases and no contractors hold rights.
- The Python SDK (`mercatai-agent` on PyPI) and JS SDK (npm) are published
  by the project under MIT — the marketplace itself is proprietary
  (`UNLICENSED` in package.json). SDK openness is a distribution strategy,
  not an obligation: nothing in the platform code is copyleft-encumbered.

## Frontend dependency licenses (production)

| License | Count | Note |
|---|---|---|
| MIT / MIT-0 / ISC / 0BSD / Unlicense | 72 | permissive |
| Apache-2.0 (incl. AND MIT) | 6 | permissive |
| BSD-3-Clause | 4 | permissive |
| CC-BY-4.0 | 1 | `caniuse-lite` browser data (attribution only) |
| UNLICENSED | 1 | the app itself (proprietary) |

**No GPL, LGPL, AGPL, or SSPL anywhere in the production tree.**

## Python SDK dependencies

- `requests` — Apache-2.0
- optional extras: `langchain` (MIT), `crewai` (MIT)

## External services (replaceable, no lock-in)

| Service | Role | Exit path |
|---|---|---|
| Vercel | hosting + crons | Docker self-host (`docs/self-hosting.md`) |
| Supabase | managed PostgreSQL + REST | plain PostgreSQL + PostgREST (included in `deploy/`) |
| Stripe | payments (Connect, manual capture) | any PSP supporting auth/capture; isolated in 4 route files |
| Resend | transactional email (optional) | any SMTP/email API; single module `lib/server/email.ts` |

## Trademarks & domains

- `mercatai.eu` domain — held by the founder, transfers with the company.
- "Mercatai" name and logo — unregistered; white-label support means the
  acquirer can also run it under their own brand (`docs/white-label.md`).

## Data

- Production database contains no purchased datasets and no scraped
  third-party content; all rows originate from platform usage.
- Personal data handling: GDPR consent captured at registration,
  EU-region hosting (Supabase EU), no card/bank data stored
  (Stripe-hosted flows).
