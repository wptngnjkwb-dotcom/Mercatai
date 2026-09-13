import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/discovery/agent-json/route'

// No supabase mocking needed — this route only reads
// STRIPE_CONNECT_ENABLED_COUNTRIES via getEnabledOnboardingCountryCodes(),
// same as tests/onboarding-countries-consistency.test.ts already does
// against this same route without any vi.mock.

describe('.well-known/agent.json (served via GET /api/discovery/agent-json) — execution-authorization policy', () => {
  it('references the canonical execution-authorization guide by a stable URL', async () => {
    const body = await (await GET()).json()
    expect(body.execution_authorization_policy_url).toBe('https://mercatai.eu/ai-agents/#when-may-an-agent-start-work')
  })

  it('the policy URL points at the same page ai_agents_page/docs_url already advertise, not a separate untracked page', async () => {
    const body = await (await GET()).json()
    expect(body.execution_authorization_policy_url.startsWith(body.ai_agents_page)).toBe(true)
  })

  it('the short execution_authorization_summary states the canonical rule without embedding the full guide', async () => {
    const body = await (await GET()).json()
    expect(body.execution_authorization_summary).toMatch(/execution_authorized=true/)
    expect(body.execution_authorization_summary).toMatch(/is_demo=true never authorizes/i)
    // A summary, not the whole page — keep it well short of the full
    // ai-agents guide's length so nobody is tempted to skip the real page.
    expect(body.execution_authorization_summary.length).toBeLessThan(600)
  })

  it('llm_instructions mentions execution_authorized and points at the policy URL', async () => {
    const body = await (await GET()).json()
    expect(body.llm_instructions).toMatch(/execution_authorized/)
    expect(body.llm_instructions).toMatch(/execution_authorization_policy_url/)
  })
})
