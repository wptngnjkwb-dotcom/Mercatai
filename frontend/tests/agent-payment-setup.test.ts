import { beforeEach, describe, expect, it, vi } from 'vitest'

const { retrieveAccount, auditLog } = vi.hoisted(() => ({
  retrieveAccount: vi.fn(),
  auditLog: vi.fn(async () => {}),
}))

vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return { accounts: { retrieve: retrieveAccount } }
  }),
}))
vi.mock('@/lib/server/audit', () => ({ auditLog }))

import { getLiveAgentPaymentSetup, paymentSetupRequiredBody } from '@/lib/server/agentPaymentSetup'

function readyAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct_standard',
    type: 'standard',
    country: 'CZ',
    controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' } },
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
    requirements: { currently_due: [] },
    capabilities: { card_payments: 'active', sepa_debit_payments: 'active', transfers: 'inactive' },
    ...overrides,
  }
}

function dbFixture() {
  const updates: Record<string, unknown>[] = []
  return {
    updates,
    db: {
      from(table: string) {
        let update: Record<string, unknown> | null = null
        const builder: any = {
          update(values: Record<string, unknown>) { update = values; if (table === 'agents') updates.push(values); return builder },
          eq() { return builder },
          then(resolve: (value: unknown) => unknown) { return resolve({ data: update ? [{ id: 'agent-1' }] : null, error: null }) },
        }
        return builder
      },
    } as any,
  }
}

describe('live agent payment setup', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    process.env.STRIPE_CONNECT_ENABLED_COUNTRIES = 'CZ'
    process.env.STRIPE_DIRECT_CHARGE_COUNTRIES = 'CZ'
    retrieveAccount.mockReset()
    auditLog.mockClear()
  })

  it('returns an actionable Standard onboarding endpoint without calling Stripe when no account exists', async () => {
    const { db } = dbFixture()
    const result = await getLiveAgentPaymentSetup({
      db,
      agent: { id: 'agent-1', stripe_standard_account_id: null },
      requirement: 'standard_agent_liability',
    })

    expect(result).toMatchObject({ ready: false, status: 'not_started', nextAction: 'start_stripe_onboarding', onboardingEndpoint: '/api/v1/agents/agent-1/stripe-onboard' })
    expect(retrieveAccount).not.toHaveBeenCalled()
  })

  it('keeps the task id only for the assigned legacy Express pilot onboarding endpoint', async () => {
    const { db } = dbFixture()
    const result = await getLiveAgentPaymentSetup({
      db,
      agent: { id: 'agent-1', stripe_account_id: null },
      requirement: 'legacy_express_platform_liability',
      taskId: 'pilot-task',
    })
    expect(result.onboardingEndpoint).toBe('/api/v1/agents/agent-1/stripe-onboard?task_id=pilot-task')
  })

  it('derives ready from the live Standard account and repairs the cached completion flag', async () => {
    retrieveAccount.mockResolvedValueOnce(readyAccount())
    const { db, updates } = dbFixture()
    const result = await getLiveAgentPaymentSetup({
      db,
      agent: { id: 'agent-1', stripe_standard_account_id: 'acct_standard', stripe_standard_onboarding_completed: false },
      requirement: 'standard_agent_liability',
    })

    expect(result).toMatchObject({ ready: true, status: 'ready', nextAction: 'ready_to_bid', country: 'CZ' })
    expect(updates).toContainEqual({ stripe_standard_onboarding_completed: true })
  })

  it('classifies Stripe-side verification as pending and does not claim readiness', async () => {
    retrieveAccount.mockResolvedValueOnce(readyAccount({ requirements: { currently_due: [], disabled_reason: 'requirements.pending_verification' } }))
    const { db } = dbFixture()
    const result = await getLiveAgentPaymentSetup({
      db,
      agent: { id: 'agent-1', stripe_standard_account_id: 'acct_standard', stripe_standard_onboarding_completed: true },
      requirement: 'standard_agent_liability',
    })
    expect(result).toMatchObject({ ready: false, status: 'pending_verification', nextAction: 'wait_for_stripe' })
  })

  it('fails closed on an account model mismatch', async () => {
    retrieveAccount.mockResolvedValueOnce(readyAccount({ type: 'express', controller: { fees: { payer: 'application' }, losses: { payments: 'application' } } }))
    const { db } = dbFixture()
    const result = await getLiveAgentPaymentSetup({
      db,
      agent: { id: 'agent-1', stripe_standard_account_id: 'acct_wrong', stripe_standard_onboarding_completed: true },
      requirement: 'standard_agent_liability',
    })
    expect(result).toMatchObject({ ready: false, status: 'restricted', nextAction: 'contact_stripe_support', reason: 'stripe_account_model_mismatch' })
  })

  it('returns a stable structured 402 body without leaking Stripe details', async () => {
    const body = paymentSetupRequiredBody({
      ready: false, status: 'onboarding_required', nextAction: 'continue_stripe_onboarding', accountId: 'acct_secret', country: 'CZ', onboardingEndpoint: '/api/v1/agents/agent-1/stripe-onboard', reason: 'raw_reason',
    })
    expect(body).toEqual({
      error: 'The agent must complete the required Stripe payment setup before this action can continue.',
      code: 'agent_payment_setup_required',
      payment_setup_status: 'onboarding_required',
      payment_ready: false,
      next_action: 'continue_stripe_onboarding',
      onboarding_endpoint: '/api/v1/agents/agent-1/stripe-onboard',
    })
    expect(JSON.stringify(body)).not.toContain('acct_secret')
    expect(JSON.stringify(body)).not.toContain('raw_reason')
  })
})
