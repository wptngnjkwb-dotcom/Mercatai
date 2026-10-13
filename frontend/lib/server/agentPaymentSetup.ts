import type Stripe from 'stripe'
import type { getSupabase } from '@/lib/server/supabase'
import { isPaymentCountryEnabled } from '@/lib/server/stripeConnectCountries'
import {
  classifyDisabledReason,
  computeStripeAccountReadiness,
  syncOnboardingCompletedFlag,
} from '@/lib/server/stripeAccountReadiness'
import {
  type StripeAccountRequirement,
  stripeAccountFields,
  stripeAccountMatchesRequirement,
} from '@/lib/server/stripeAccountRequirement'

export type PaymentSetupStatus =
  | 'not_started'
  | 'onboarding_required'
  | 'pending_verification'
  | 'ready'
  | 'restricted'

export interface PaymentSetupAgentRow {
  id: string
  stripe_account_id?: string | null
  stripe_onboarding_completed?: boolean | null
  stripe_standard_account_id?: string | null
  stripe_standard_onboarding_completed?: boolean | null
}

export interface AgentPaymentSetupResult {
  ready: boolean
  status: PaymentSetupStatus
  nextAction: 'start_stripe_onboarding' | 'continue_stripe_onboarding' | 'wait_for_stripe' | 'contact_stripe_support' | 'ready_to_bid'
  accountId: string | null
  country: string | null
  onboardingEndpoint: string
  reason: string | null
  readiness?: ReturnType<typeof computeStripeAccountReadiness>
  account?: Stripe.Account
}

export class PaymentSetupLookupError extends Error {}

function onboardingEndpoint(agentId: string, requirement: StripeAccountRequirement, taskId?: string | null) {
  const base = `/api/v1/agents/${encodeURIComponent(agentId)}/stripe-onboard`
  return requirement === 'legacy_express_platform_liability' && taskId
    ? `${base}?task_id=${encodeURIComponent(taskId)}`
    : base
}

export async function getLiveAgentPaymentSetup(params: {
  db: ReturnType<typeof getSupabase>
  agent: PaymentSetupAgentRow
  requirement: StripeAccountRequirement
  taskId?: string | null
}): Promise<AgentPaymentSetupResult> {
  const endpoint = onboardingEndpoint(params.agent.id, params.requirement, params.taskId)
  const fields = stripeAccountFields(params.requirement)
  const accountId = params.agent[fields.accountId] ?? null
  if (!accountId) {
    return { ready: false, status: 'not_started', nextAction: 'start_stripe_onboarding', accountId: null, country: null, onboardingEndpoint: endpoint, reason: 'stripe_account_missing' }
  }
  if (!process.env.STRIPE_SECRET_KEY) throw new PaymentSetupLookupError('Stripe is not configured')

  const StripeClient = (await import('stripe')).default
  const stripe = new StripeClient(process.env.STRIPE_SECRET_KEY)
  let account: Stripe.Account
  try {
    const retrieved = await stripe.accounts.retrieve(accountId)
    if ('deleted' in retrieved && retrieved.deleted) {
      return { ready: false, status: 'restricted', nextAction: 'contact_stripe_support', accountId, country: null, onboardingEndpoint: endpoint, reason: 'stripe_account_deleted' }
    }
    account = retrieved as Stripe.Account
  } catch {
    throw new PaymentSetupLookupError('Could not verify the agent payment account')
  }

  if (!stripeAccountMatchesRequirement(account, params.requirement)) {
    return { ready: false, status: 'restricted', nextAction: 'contact_stripe_support', accountId, country: account.country?.toUpperCase() ?? null, onboardingEndpoint: endpoint, reason: 'stripe_account_model_mismatch', account }
  }

  const readiness = computeStripeAccountReadiness(account)
  await syncOnboardingCompletedFlag(
    params.db,
    params.agent.id,
    params.agent[fields.onboardingCompleted] ?? false,
    readiness.onboardingComplete,
    fields.onboardingCompleted,
  )
  const country = account.country?.toUpperCase() ?? null
  if (!country || !isPaymentCountryEnabled(country, fields.stripeType)) {
    return { ready: false, status: 'restricted', nextAction: 'contact_stripe_support', accountId, country, onboardingEndpoint: endpoint, reason: 'country_not_payment_enabled', readiness, account }
  }

  const disabled = classifyDisabledReason(account.requirements?.disabled_reason)
  if (disabled.action === 'wait_for_stripe') {
    return { ready: false, status: 'pending_verification', nextAction: 'wait_for_stripe', accountId, country, onboardingEndpoint: endpoint, reason: disabled.disabledReason, readiness, account }
  }
  if (disabled.action === 'manual_stripe_dashboard_review') {
    return { ready: false, status: 'restricted', nextAction: 'contact_stripe_support', accountId, country, onboardingEndpoint: endpoint, reason: disabled.disabledReason, readiness, account }
  }

  // Card acceptance is the common payment path offered for every rollout
  // country. Requiring it here prevents an agent with only a partially-ready
  // SEPA capability from bidding on work whose buyer later chooses card.
  if (!readiness.payoutReady || !readiness.cardReady || !readiness.identityVerified) {
    const pending = readiness.cardPaymentsStatus === 'pending'
      || readiness.sepaDebitPaymentsStatus === 'pending'
      || readiness.transfersStatus === 'pending'
    return {
      ready: false,
      status: pending ? 'pending_verification' : 'onboarding_required',
      nextAction: pending ? 'wait_for_stripe' : 'continue_stripe_onboarding',
      accountId,
      country,
      onboardingEndpoint: endpoint,
      reason: pending ? 'stripe_capability_pending' : 'stripe_requirements_incomplete',
      readiness,
      account,
    }
  }

  return { ready: true, status: 'ready', nextAction: 'ready_to_bid', accountId, country, onboardingEndpoint: endpoint, reason: null, readiness, account }
}

/** Safe, structured body shared by bid, acceptance and Store-hire gates. */
export function paymentSetupRequiredBody(result: AgentPaymentSetupResult, includeOnboardingEndpoint = true) {
  return {
    error: 'The agent must complete the required Stripe payment setup before this action can continue.',
    code: 'agent_payment_setup_required',
    payment_setup_status: result.status,
    payment_ready: false,
    next_action: result.nextAction,
    ...(includeOnboardingEndpoint ? { onboarding_endpoint: result.onboardingEndpoint } : {}),
  }
}
