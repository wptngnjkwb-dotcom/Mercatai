import type { getSupabase } from '@/lib/server/supabase'
import type Stripe from 'stripe'

export const STANDARD_AGENT_LIABILITY = 'standard_agent_liability' as const
export const LEGACY_EXPRESS_PLATFORM_LIABILITY = 'legacy_express_platform_liability' as const

export type StripeAccountRequirement =
  | typeof STANDARD_AGENT_LIABILITY
  | typeof LEGACY_EXPRESS_PLATFORM_LIABILITY

export const LEGACY_EXPRESS_PILOT_TASK_IDS = new Set([
  'e427ab6c-62fa-473f-8e84-93003b13a47f',
  '49a315bc-70ea-409d-b46d-d60ac369e23a',
  '2ee876c6-ebc7-489e-b138-306ecdb32eaf',
])

export function isLegacyExpressPilotTask(taskId: string): boolean {
  return LEGACY_EXPRESS_PILOT_TASK_IDS.has(taskId)
}

export interface StripeAccountFieldNames {
  accountId: 'stripe_standard_account_id' | 'stripe_account_id'
  onboardingCompleted: 'stripe_standard_onboarding_completed' | 'stripe_onboarding_completed'
  stripeType: 'standard' | 'express'
  feePayer: 'stripe' | 'application'
  lossesCollector: 'stripe' | 'application'
}

export function stripeAccountFields(requirement: StripeAccountRequirement): StripeAccountFieldNames {
  if (requirement === LEGACY_EXPRESS_PLATFORM_LIABILITY) {
    return {
      accountId: 'stripe_account_id',
      onboardingCompleted: 'stripe_onboarding_completed',
      stripeType: 'express',
      feePayer: 'application',
      lossesCollector: 'application',
    }
  }
  return {
    accountId: 'stripe_standard_account_id',
    onboardingCompleted: 'stripe_standard_onboarding_completed',
    stripeType: 'standard',
    feePayer: 'stripe',
    lossesCollector: 'stripe',
  }
}

export function isStripeAccountRequirement(value: unknown): value is StripeAccountRequirement {
  return value === STANDARD_AGENT_LIABILITY || value === LEGACY_EXPRESS_PLATFORM_LIABILITY
}

/**
 * Resolves an optional task-scoped onboarding request. No task means the
 * safe default: Standard. The legacy Express mode is available only after
 * one of the explicitly migrated pilot tasks has been assigned to this
 * exact agent. A caller cannot select Express by passing a mode string.
 */
export async function resolveOnboardingRequirement(
  db: ReturnType<typeof getSupabase>,
  taskId: string | null | undefined,
  agentDbId: string
): Promise<{ requirement: StripeAccountRequirement; taskId: string | null } | { error: string; status: number }> {
  if (!taskId) return { requirement: STANDARD_AGENT_LIABILITY, taskId: null }

  const { data: task, error } = await db
    .from('tasks')
    .select('id, assigned_agent_id, stripe_account_requirement, archived_at')
    .eq('id', taskId)
    .maybeSingle()
  if (error) return { error: 'Could not verify the task payment configuration', status: 500 }
  if (!task) return { error: 'Task not found', status: 404 }
  if (task.archived_at) return { error: 'Archived tasks cannot start Stripe onboarding', status: 409 }
  if (!isStripeAccountRequirement(task.stripe_account_requirement)) {
    return { error: 'Task has an invalid Stripe account requirement', status: 500 }
  }
  if (task.stripe_account_requirement === LEGACY_EXPRESS_PLATFORM_LIABILITY
      && !isLegacyExpressPilotTask(task.id)) {
    return { error: 'Express onboarding is not available for this task', status: 409 }
  }
  // Admin authentication permits managing onboarding on an agent's behalf,
  // but it must never bypass the task-to-agent assignment. Otherwise an
  // admin request carrying any one of the three public pilot UUIDs could
  // create a new Express account for an unrelated agent, reintroducing a
  // manual Express-registration path that this migration intentionally
  // removes.
  if (task.assigned_agent_id !== agentDbId) {
    return { error: 'This task-specific Stripe onboarding is available only to its assigned agent', status: 403 }
  }
  return { requirement: task.stripe_account_requirement, taskId: task.id }
}

export function publicPaymentResponsibility(requirement: StripeAccountRequirement) {
  const fields = stripeAccountFields(requirement)
  return {
    stripe_account_requirement: requirement,
    stripe_account_type: fields.stripeType,
    stripe_dashboard: fields.stripeType === 'standard' ? 'full' : 'express',
    stripe_fee_payer: fields.feePayer === 'stripe' ? 'agent_connected_account' : 'mercatai_platform',
    stripe_negative_balance_responsibility: fields.lossesCollector,
    agent_operator_manages_refunds_and_disputes: fields.stripeType === 'standard',
    mercatai_platform_loss_liability: fields.lossesCollector === 'application',
  }
}

/**
 * Fail closed if a stored connected-account id points at the wrong Stripe
 * controller model. `type` is the stable public discriminator. When Stripe
 * includes controller responsibility fields, verify those too so a future
 * API change cannot silently turn an agent-liability Standard flow back into
 * platform liability.
 */
export function stripeAccountMatchesRequirement(
  account: Pick<Stripe.Account, 'type' | 'controller'>,
  requirement: StripeAccountRequirement
): boolean {
  const expected = stripeAccountFields(requirement)
  if (account.type !== expected.stripeType) return false

  const feePayer = account.controller?.fees?.payer
  const lossesCollector = account.controller?.losses?.payments
  // Stripe's legacy `type` shorthand uses more specific v1 fee-payer
  // values than the responsibility names exposed by Accounts v2:
  //
  //   type=express  -> application_express (or application)
  //   type=standard -> account
  //
  // Treat those as aliases of the same financial responsibility, not as a
  // mismatch. In particular, `application_express` still means Mercatai is
  // charged Stripe fees; `account` means the Standard connected account is.
  // Keep this fail-closed for every other value so Custom/platform-paid
  // configurations cannot silently enter the Standard agent-liability flow.
  if (feePayer) {
    const feePayerMatches = requirement === LEGACY_EXPRESS_PLATFORM_LIABILITY
      ? feePayer === 'application' || feePayer === 'application_express'
      : feePayer === 'account' || (feePayer as string) === 'stripe'
    if (!feePayerMatches) return false
  }
  if (lossesCollector && lossesCollector !== expected.lossesCollector) return false
  return true
}
