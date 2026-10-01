import crypto from 'crypto'
import { getSupabase } from './supabase'
import {
  buildOpportunityAlertProviderPayload,
  sendOpportunityAlertOrThrow,
  type FrozenOpportunityAlertPayload,
} from './email'

type Db = ReturnType<typeof getSupabase>

// Shared with retryOpportunityAlertDeliveries' cutoff and the catch block in
// processOpportunityAlertDelivery below, which clears payload_snapshot once
// a delivery hits this many attempts — the two must agree, or a delivery
// could stop being retried while its snapshot (containing the agent
// operator's email) is still retained, undercutting the Privacy Policy's
// "retained only while pending or retrying" claim.
const MAX_DELIVERY_ATTEMPTS = 20

export interface OpportunityTask {
  id: string
  title: string
  category: string
  required_capabilities: string[] | null
  budget_max_eur: number
  deadline_hours: number
}

export interface OpportunitySubscription {
  id: string
  agent_id: string
  categories: string[] | null
  capabilities: string[] | null
  locale: 'en' | 'cs' | 'de' | 'es' | string
}

export function matchesOpportunitySubscription(
  subscription: Pick<OpportunitySubscription, 'categories' | 'capabilities'>,
  task: Pick<OpportunityTask, 'category' | 'required_capabilities'>,
): boolean {
  const categories = subscription.categories ?? []
  if (categories.length > 0 && !categories.includes(task.category)) return false
  const wantedCapabilities = subscription.capabilities ?? []
  const taskCapabilities = task.required_capabilities ?? []
  if (wantedCapabilities.length > 0) {
    if (taskCapabilities.length === 0) return false
    if (!wantedCapabilities.some((capability) => taskCapabilities.includes(capability))) return false
  }
  return true
}

function safeStoredError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500)
}

function isFrozenPayload(value: unknown): value is FrozenOpportunityAlertPayload {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.from === 'string'
    && typeof p.to === 'string'
    && typeof p.subject === 'string'
    && typeof p.html === 'string'
    && typeof p.payloadVersion === 'number'
}

export async function processOpportunityAlertDelivery(db: Db, deliveryId: string): Promise<'sent' | 'skipped' | 'failed'> {
  const { data: claimData, error: claimError } = await db.rpc('claim_opportunity_alert_delivery', {
    p_delivery_id: deliveryId,
    p_lease_seconds: 300,
  })
  if (claimError) throw new Error(`Could not claim opportunity alert delivery: ${claimError.message}`)
  const claim = Array.isArray(claimData) ? claimData[0] : claimData
  if (!claim) return 'skipped'
  if (!claim.claim_token || !isFrozenPayload(claim.payload_snapshot)) {
    throw new Error('Claimed opportunity alert delivery has no valid frozen payload')
  }

  // Opt-out wins even after a delivery was queued or previously failed. A
  // disabled subscription (or deactivated/deleted agent) must never be
  // resurrected by the retry cron.
  const { data: subscription, error: subscriptionError } = await db
    .from('opportunity_alert_subscriptions')
    .select('is_active,agent_id')
    .eq('id', claim.subscription_id)
    .maybeSingle()
  let recipientActive = false
  if (!subscriptionError && subscription?.is_active) {
    const { data: agent, error: agentError } = await db
      .from('agents')
      .select('is_active')
      .eq('id', subscription.agent_id)
      .maybeSingle()
    recipientActive = !agentError && agent?.is_active === true
  }
  if (!recipientActive) {
    const { error: cancelError } = await db
      .from('opportunity_alert_deliveries')
      .update({ status: 'cancelled', payload_snapshot: null, claim_token: null, claimed_at: null, last_error: null })
      .eq('id', deliveryId)
      .eq('status', 'sending')
      .eq('claim_token', claim.claim_token)
    if (cancelError) throw new Error(`Could not cancel an opted-out opportunity alert: ${cancelError.message}`)
    return 'skipped'
  }

  const keyMaterial = `opportunity:${claim.subscription_id}:${claim.task_id}`
  const idempotencyKey = `mercatai-opportunity-${crypto.createHash('sha256').update(keyMaterial).digest('hex')}`
  try {
    const providerId = await sendOpportunityAlertOrThrow(claim.payload_snapshot, idempotencyKey)
    const { data: marked, error: markError } = await db
      .from('opportunity_alert_deliveries')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_id: providerId,
        last_error: null,
        payload_snapshot: null,
        claim_token: null,
        claimed_at: null,
      })
      .eq('id', deliveryId)
      .eq('status', 'sending')
      .eq('claim_token', claim.claim_token)
      .select('id')
      .maybeSingle()
    if (markError || !marked) throw new Error(`Could not confirm opportunity alert delivery: ${markError?.message ?? 'lease lost'}`)
    return 'sent'
  } catch (error) {
    // retryOpportunityAlertDeliveries never selects a row at or past
    // MAX_DELIVERY_ATTEMPTS, so this was its last possible attempt — the
    // frozen payload (and the agent operator's email inside it) must be
    // cleared now, not left behind indefinitely on a delivery nothing will
    // ever process again.
    const exhausted = typeof claim.attempt_count === 'number' && claim.attempt_count >= MAX_DELIVERY_ATTEMPTS
    const { error: markError } = await db
      .from('opportunity_alert_deliveries')
      .update({
        status: 'failed',
        last_error: safeStoredError(error),
        claim_token: null,
        claimed_at: null,
        ...(exhausted ? { payload_snapshot: null } : {}),
      })
      .eq('id', deliveryId)
      .eq('status', 'sending')
      .eq('claim_token', claim.claim_token)
    if (markError) throw new Error(`Opportunity alert failed and could not be marked retryable: ${markError.message}`)
    return 'failed'
  }
}

/**
 * Enqueue and immediately attempt email alerts for one newly published task.
 * The database is re-read and checked fail-closed: archived, non-approved,
 * platform-seed/demo, or non-biddable tasks never generate an alert.
 */
export async function dispatchOpportunityAlerts(task: OpportunityTask): Promise<{ matched: number; sent: number }> {
  const db = getSupabase()
  try {
    const { data: currentTask, error: taskError } = await db
      .from('tasks')
      .select('id,status,moderation_status,archived_at,published_at,posted_by_org_id,organizations!posted_by_org_id(is_platform_seed)')
      .eq('id', task.id)
      .maybeSingle()
    if (taskError || !currentTask) return { matched: 0, sent: 0 }
    const organization = currentTask.organizations as any
    const isPlatformSeed = Array.isArray(organization) ? organization[0]?.is_platform_seed : organization?.is_platform_seed
    if (currentTask.archived_at || currentTask.moderation_status !== 'approved' || !currentTask.published_at || isPlatformSeed !== false) {
      return { matched: 0, sent: 0 }
    }
    if (!['open', 'bidding'].includes(currentTask.status)) return { matched: 0, sent: 0 }

    const { data: subscriptions, error: subscriptionError } = await db
      .from('opportunity_alert_subscriptions')
      .select('id,agent_id,categories,capabilities,locale')
      .eq('is_active', true)
    if (subscriptionError || !subscriptions?.length) return { matched: 0, sent: 0 }

    const matching = (subscriptions as OpportunitySubscription[])
      .filter((subscription) => matchesOpportunitySubscription(subscription, task))
    if (matching.length === 0) return { matched: 0, sent: 0 }

    const agentIds = Array.from(new Set(matching.map((subscription) => subscription.agent_id)))
    const { data: agents, error: agentsError } = await db
      .from('agents')
      .select('id,owner_email,is_active')
      .in('id', agentIds)
    if (agentsError) return { matched: 0, sent: 0 }
    const agentsById = new Map((agents ?? []).map((agent: any) => [agent.id, agent]))

    let sent = 0
    let matched = 0
    for (const subscription of matching) {
      const agent = agentsById.get(subscription.agent_id)
      if (!agent?.is_active || typeof agent.owner_email !== 'string' || !agent.owner_email.includes('@')) continue
      matched += 1
      const locale = ['en', 'cs', 'de', 'es'].includes(subscription.locale) ? subscription.locale as 'en' | 'cs' | 'de' | 'es' : 'en'
      const payload = buildOpportunityAlertProviderPayload({
        to: agent.owner_email,
        locale,
        taskId: task.id,
        title: task.title,
        category: task.category,
        budgetMaxEur: task.budget_max_eur,
        deadlineHours: task.deadline_hours,
        capabilities: task.required_capabilities ?? [],
      })
      const { error: insertError } = await db
        .from('opportunity_alert_deliveries')
        .upsert({
          subscription_id: subscription.id,
          task_id: task.id,
          status: 'pending',
          payload_snapshot: payload,
        }, { onConflict: 'subscription_id,task_id', ignoreDuplicates: true })
      if (insertError) continue

      const { data: delivery, error: deliveryError } = await db
        .from('opportunity_alert_deliveries')
        .select('id,status')
        .eq('subscription_id', subscription.id)
        .eq('task_id', task.id)
        .maybeSingle()
      if (deliveryError || !delivery || delivery.status === 'sent') continue
      if (await processOpportunityAlertDelivery(db, delivery.id) === 'sent') sent += 1
    }
    return { matched, sent }
  } catch {
    // Alerts must never make task publication fail. Any row already inserted
    // remains retryable by the authenticated cron route.
    return { matched: 0, sent: 0 }
  }
}

export async function retryOpportunityAlertDeliveries(limit = 50): Promise<{ attempted: number; sent: number; failed: number }> {
  const db = getSupabase()
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('opportunity_alert_deliveries')
    .select('id,status,claimed_at,attempt_count')
    .or(`status.in.(pending,failed),and(status.eq.sending,claimed_at.lt.${staleBefore})`)
    .lt('attempt_count', MAX_DELIVERY_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)))
  if (error) throw new Error(`Could not list retryable opportunity alerts: ${error.message}`)
  let sent = 0
  let failed = 0
  for (const delivery of data ?? []) {
    const result = await processOpportunityAlertDelivery(db, delivery.id)
    if (result === 'sent') sent += 1
    if (result === 'failed') failed += 1
  }
  return { attempted: data?.length ?? 0, sent, failed }
}
