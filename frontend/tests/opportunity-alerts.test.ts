import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { matchesOpportunitySubscription } from '@/lib/server/opportunityAlerts'
import { buildOpportunityAlertProviderPayload } from '@/lib/server/email'

const root = join(__dirname, '..')

describe('opportunity-alert matching', () => {
  const task = { category: 'research', required_capabilities: ['market_research', 'data_analysis'] }

  it('treats empty filters as any and otherwise requires category plus capability overlap', () => {
    expect(matchesOpportunitySubscription({ categories: [], capabilities: [] }, task)).toBe(true)
    expect(matchesOpportunitySubscription({ categories: ['research'], capabilities: ['data_analysis'] }, task)).toBe(true)
    expect(matchesOpportunitySubscription({ categories: ['translation'], capabilities: ['data_analysis'] }, task)).toBe(false)
    expect(matchesOpportunitySubscription({ categories: ['research'], capabilities: ['code_review'] }, task)).toBe(false)
  })

  it('does not match a capability-filtered subscription to a task with no declared capabilities', () => {
    expect(matchesOpportunitySubscription(
      { categories: [], capabilities: ['research'] },
      { category: 'research', required_capabilities: [] },
    )).toBe(false)
  })
})

describe('opportunity-alert email contract', () => {
  it('says the task is not funded, gives the exact execution gate, escapes buyer text, and offers settings', () => {
    const payload = buildOpportunityAlertProviderPayload({
      to: 'operator@example.com',
      locale: 'en',
      taskId: 'task-1',
      title: '<img src=x onerror=alert(1)> Research',
      category: 'research',
      budgetMaxEur: 49,
      deadlineHours: 24,
      capabilities: ['market_research'],
    })
    expect(payload.to).toBe('operator@example.com')
    expect(payload.subject).not.toMatch(/[\r\n]/)
    expect(payload.html).toContain('This task is not funded yet')
    expect(payload.html).toContain('funding_status: funded')
    expect(payload.html).toContain('execution_authorized: true')
    expect(payload.html).toContain('/agent/autobid#opportunity-alerts')
    expect(payload.html).toContain('&lt;img')
    expect(payload.html).not.toContain('<img src=x')
    expect(JSON.stringify(payload)).not.toMatch(/RESEND_API_KEY|sk_live_|sk_test_/)
  })

  it.each(['en', 'cs', 'de', 'es'] as const)('has non-empty localized copy for %s', (locale) => {
    const payload = buildOpportunityAlertProviderPayload({
      to: 'operator@example.com', locale, taskId: 'task-1', title: 'Task', category: 'research',
      budgetMaxEur: 10, deadlineHours: 2, capabilities: [],
    })
    expect(payload.subject.trim().length).toBeGreaterThan(10)
    expect(payload.html).toContain('execution_authorized: true')
  })
})

describe('opportunity-alert durability and webhook hardening', () => {
  const migration = readFileSync(join(root, 'sql', '23_opportunity_alerts.sql'), 'utf8')
  const webhookRoute = readFileSync(join(root, 'app', 'api', 'v1', 'agents', '[id]', 'webhook', 'route.ts'), 'utf8')
  const autoBid = readFileSync(join(root, 'lib', 'server', 'autobid.ts'), 'utf8')
  const notification = readFileSync(join(root, 'lib', 'server', 'agentNotifications.ts'), 'utf8')

  it('has one delivery per subscription/task, a reclaimable lease, RLS, and service-role-only RPC access', () => {
    expect(migration).toMatch(/UNIQUE\s*\(subscription_id, task_id\)/i)
    expect(migration).toMatch(/claim_opportunity_alert_delivery/i)
    expect(migration).toMatch(/status = 'sending'/i)
    expect(migration).toMatch(/'cancelled'/i)
    expect(migration).toMatch(/claimed_at < NOW\(\) - make_interval/i)
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION claim_opportunity_alert_delivery\(UUID, INTEGER\) FROM PUBLIC, anon, authenticated/i)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION claim_opportunity_alert_delivery\(UUID, INTEGER\) TO service_role/i)
  })

  it('validates agent webhook URLs before storage and delivery, requires HTTPS, blocks redirects, and never downgrades to unsigned', () => {
    expect(webhookRoute).toContain("import { validateWebhookUrl }")
    expect(webhookRoute).toContain("url.startsWith('https://')")
    expect(webhookRoute).toContain('await validateWebhookUrl(url)')
    expect(autoBid).toContain('await validateWebhookUrl(url)')
    expect(autoBid).toContain("if (!secret || !url.startsWith('https://')) return")
    expect(autoBid).toContain("redirect: 'error'")
    expect(notification).toContain("redirect: 'error'")
  })

  it('dispatches email alerts independently even when auto-bidding exits early', () => {
    expect(autoBid).toMatch(/finally\s*\{[\s\S]*dispatchOpportunityAlerts\(task\)/)
  })

  it('re-checks opt-in and agent activity before every send or retry', () => {
    const dispatcher = readFileSync(join(root, 'lib', 'server', 'opportunityAlerts.ts'), 'utf8')
    expect(dispatcher).toContain(".from('opportunity_alert_subscriptions')")
    expect(dispatcher).toContain(".select('is_active,agent_id')")
    expect(dispatcher).toContain("status: 'cancelled'")
    expect(dispatcher).toContain('isPlatformSeed !== false')
  })
})
