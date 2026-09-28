import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { PUT as putDispute } from '@/app/api/v1/tasks/[id]/dispute/route'
import { PUT as putResolve } from '@/app/api/v1/admin/resolve/[taskId]/route'
import { GET as getOpenApiSpec } from '@/app/api/v1/openapi/route'
import { GET as getDiscoveryJson } from '@/app/api/discovery/agent-json/route'
import { POST as legacyRefund } from '@/app/api/v1/payments/refund/[taskId]/route'
import { signToken } from '@/lib/server/auth'

process.env.JWT_SECRET_KEY = 'test-secret-for-quality-policy-32-chars'

const root = resolve(process.cwd(), '..')

describe('legacy dispute/admin-resolve endpoints are retired, not just hidden', () => {
  it('PUT /api/v1/tasks/{id}/dispute returns 410 with the canonical replacement endpoint', async () => {
    const res = await putDispute()
    const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.canonical_endpoint).toBe('/api/v1/tasks/{id}/issues')
  })

  it('PUT /api/v1/admin/resolve/{taskId} returns 410 — Mercatai cannot decide a dispute any more, even as admin', async () => {
    const res = await putResolve()
    const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.error).toMatch(/does not decide/i)
  })

  it('the old buyer/admin refund endpoint is also retired with 410', async () => {
    const token = await signToken({ tier: 'admin' }, '15m')
    const req = new Request('http://localhost/api/v1/payments/refund/task-1', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    const res = await legacyRefund(req as any, { params: { taskId: 'task-1' } })
    expect(res.status).toBe(410)
    expect(await res.text()).toMatch(/does not decide marketplace refunds/i)
  })

  it('neither retired route file references refund_buyer, pay_agent, or a Stripe call any more', () => {
    const disputeSrc = readFileSync(resolve(root, 'frontend/app/api/v1/tasks/[id]/dispute/route.ts'), 'utf8')
    const resolveSrc = readFileSync(resolve(root, 'frontend/app/api/v1/admin/resolve/[taskId]/route.ts'), 'utf8')
    for (const src of [disputeSrc, resolveSrc]) {
      expect(src).not.toMatch(/refund_buyer|pay_agent/)
      expect(src).not.toMatch(/stripe\.(refunds|paymentIntents)\./)
      expect(src).not.toContain("import Stripe")
    }
  })

  it('the non-production Python API cannot preserve the retired dispute transition either', () => {
    const legacyTasks = readFileSync(resolve(root, 'backend/routers/tasks.py'), 'utf8')
    const disputeHandler = legacyTasks.match(/@router\.put\("\/\{task_id\}\/dispute"[\s\S]*?(?=\n@router\.|\s*$)/)?.[0] ?? ''
    expect(disputeHandler).toContain('HTTP_410_GONE')
    expect(disputeHandler).not.toContain('task_disputed')
    expect(disputeHandler).not.toContain('.update({"status": "disputed"})')
  })

  it('the admin UI no longer calls /resolve or renders a "Refund buyer" / "Pay agent" action', () => {
    const adminPage = readFileSync(resolve(root, "frontend/app/[locale]/admin/page.tsx"), 'utf8')
    expect(adminPage).not.toContain('/resolve/')
    expect(adminPage).not.toContain('resolveDispute')
    expect(adminPage).not.toMatch(/Refund buyer/i)
    expect(adminPage).not.toMatch(/Pay agent/i)
  })

  it('the buyer client no longer exposes disputeTask, and exposes the quality-issue calls instead', () => {
    const apiClient = readFileSync(resolve(root, 'frontend/lib/api.ts'), 'utf8')
    expect(apiClient).not.toContain('disputeTask')
    expect(apiClient).not.toContain('/api/v1/tasks/${id}/dispute')
    for (const fn of ['openQualityIssue', 'getTaskIssues', 'postQualityIssueMessage', 'acceptQualityIssueRefund']) {
      expect(apiClient).toContain(fn)
    }
  })

  it('the buyer review screen no longer renders a bare "Dispute" button wired to the retired endpoint', () => {
    const bidsPage = readFileSync(resolve(root, "frontend/app/[locale]/(buyer)/buyer/tasks/[id]/bids/page.tsx"), 'utf8')
    expect(bidsPage).not.toContain('api.disputeTask')
    expect(bidsPage).toContain('openQualityIssue')
  })
})

describe('no leftover claim that Mercatai makes a binding decision on a dispute', () => {
  // Deliberately excludes docs/quality-issue-migration.md and this test file
  // itself, and excludes the Stripe chargeback alert email/paymentDisputes.ts,
  // which correctly and separately says Mercatai "never automatically
  // refunds or reverses a transfer" for a REAL Stripe dispute — that
  // sentence is the opposite claim and must stay.
  const SKIP_SUBSTRINGS = ['quality-issue-migration.md', 'quality-issue-policy-language.test.ts', 'paymentDisputes.ts', 'email.ts']
  const SEARCH_ROOTS = ['frontend/app', 'frontend/components', 'frontend/lib', 'docs']
  const FORBIDDEN = [
    /Mercatai (mediates|adjudicates) disputes/i,
    /binding decision/i,
    /Mercatai upholds/i,
    /Mercatai rejects (a|the) (dispute|claim)/i,
    /if Mercatai upholds/i,
  ]

  function walk(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full, files)
      else if (/\.(tsx?|md|json)$/.test(entry)) files.push(full)
    }
    return files
  }

  it('grep for binding-decision language across app/components/lib/docs', () => {
    const offenders: string[] = []
    for (const searchRoot of SEARCH_ROOTS) {
      const files = walk(resolve(root, searchRoot))
      for (const file of files) {
        if (SKIP_SUBSTRINGS.some((s) => file.includes(s))) continue
        const content = readFileSync(file, 'utf8')
        for (const pattern of FORBIDDEN) {
          if (pattern.test(content)) offenders.push(`${file}: ${pattern}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the Terms no longer promise a binding Mercatai decision within a fixed number of business days', () => {
    const terms = readFileSync(resolve(root, "frontend/app/[locale]/terms/page.tsx"), 'utf8')
    expect(terms).not.toMatch(/binding decision within \d+ business days/i)
    expect(terms).toMatch(/does not (assess|judge)/i)
  })

  it('/ai-agents gives operators the complete polling, messaging, and voluntary-refund path', () => {
    const guide = readFileSync(resolve(root, "frontend/app/[locale]/ai-agents/page.tsx"), 'utf8')
    expect(guide).toContain('GET /api/v1/tasks/&#123;id&#125;/issues')
    expect(guide).toContain('/messages')
    expect(guide).toContain('/accept-refund')
    expect(guide).toMatch(/Neither the buyer nor a Mercatai admin can force/i)
    expect(guide).toMatch(/message text is never included in the webhook/i)
  })

  it('public/internal policy text matches the implemented Stripe-dispute and private-webhook behavior', () => {
    const policy = readFileSync(resolve(root, 'docs/quality-issue-policy.md'), 'utf8')
    expect(policy).toMatch(/alerts\s+its own administrators/i)
    expect(policy).toMatch(/private,\s*signed webhook/i)
    expect(policy).not.toMatch(/Mercatai only observes and alerts the agent/i)
    expect(policy).not.toMatch(/never sent to a third-party webhook/i)
  })

  it('the public Privacy Policy discloses private-thread storage and notification processors without claiming message text is emailed', () => {
    const privacy = readFileSync(resolve(root, "frontend/app/[locale]/privacy/page.tsx"), 'utf8')
    expect(privacy).toMatch(/Quality Issue messages/i)
    expect(privacy).toMatch(/Resend.*transactional email delivery/i)
    expect(privacy).toMatch(/message text is not included in notification emails/i)
    expect(privacy).toMatch(/Do not include passwords, API keys, identity documents/i)
  })
})

describe('OpenAPI documents the full quality-issue surface with real schemas and every response code', () => {
  it('all four quality-issue operations are present', async () => {
    const spec = await (await getOpenApiSpec()).json()
    expect(spec.paths['/api/v1/tasks/{id}/issues'].post).toBeTruthy()
    expect(spec.paths['/api/v1/tasks/{id}/issues'].get).toBeTruthy()
    expect(spec.paths['/api/v1/tasks/{id}/issues/{issueId}/messages'].post).toBeTruthy()
    expect(spec.paths['/api/v1/tasks/{id}/issues/{issueId}/accept-refund'].post).toBeTruthy()
  })

  it('the retired dispute and admin-resolve endpoints are no longer documented as live operations', async () => {
    const spec = await (await getOpenApiSpec()).json()
    expect(spec.paths['/api/v1/tasks/{id}/dispute']).toBeUndefined()
    expect(spec.paths['/api/v1/admin/resolve/{taskId}']).toBeUndefined()
  })

  it('open-issue request/response schemas mark every property required', async () => {
    const spec = await (await getOpenApiSpec()).json()
    const op = spec.paths['/api/v1/tasks/{id}/issues'].post
    const reqSchema = op.requestBody.content['application/json'].schema
    expect(reqSchema.required.sort()).toEqual(['initial_message', 'reason_code'])
    const resSchema = op.responses['201'].content['application/json'].schema
    expect(resSchema.required.sort()).toEqual(Object.keys(resSchema.properties).sort())
  })

  it('accept-refund documents every realistic HTTP response code', async () => {
    const spec = await (await getOpenApiSpec()).json()
    const responses = spec.paths['/api/v1/tasks/{id}/issues/{issueId}/accept-refund'].post.responses
    for (const code of ['200', '401', '403', '404', '409', '500', '502', '503']) {
      expect(responses[code], code).toBeTruthy()
    }
  })
})

describe('discovery JSON discloses the marketplace role and quality-issue policy machine-readably', () => {
  it('carries every required field, with no absolute liability or payout guarantee language', async () => {
    const json = await (await getDiscoveryJson()).json()
    expect(json.marketplace_role).toBeTruthy()
    expect(json.merchant_of_record).toBeTruthy()
    expect(json.gross_payment_destination).toBeTruthy()
    expect(json.mercatai_receives_application_fee_only).toBe(true)
    expect(json.quality_issue_policy).toBeTruthy()
    expect(json.quality_issue_policy.mercatai_judges_quality).toBe(false)
    expect(json.quality_issue_policy.moves_money_on_open).toBe(false)
    expect(json.quality_issue_policy.review_window_extension_hours).toBe(72)
    expect(json.quality_issue_policy.agent_notification).toMatch(/signed agent webhook/i)
    expect(json.stripe_dispute_policy).toBeTruthy()
    expect(json.stripe_dispute_policy.mercatai_automatically_refunds_or_captures_on_dispute).toBe(false)
    expect(json.invoice_responsibility).toBeTruthy()
    expect(json.tax_responsibility).toBeTruthy()
    // Scoped to the fields this change actually adds — the pre-existing
    // payout_formula_note elsewhere in this payload correctly says "not a
    // guaranteed bank payout" (a disclaimer, not a guarantee) and must not
    // trip this check.
    const newFieldsRaw = JSON.stringify({
      marketplace_role_note: json.marketplace_role_note,
      quality_issue_policy: json.quality_issue_policy,
      stripe_dispute_policy: json.stripe_dispute_policy,
      invoice_responsibility: json.invoice_responsibility,
      tax_responsibility: json.tax_responsibility,
    })
    expect(newFieldsRaw).not.toMatch(/\bguarantees?\b/i)
    expect(newFieldsRaw).not.toMatch(/no liability/i)
  })
})
