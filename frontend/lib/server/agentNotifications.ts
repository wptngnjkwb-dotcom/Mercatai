import crypto from 'crypto'
import { validateWebhookUrl } from './webhookSecurity'

type Db = ReturnType<typeof import('./supabase').getSupabase>

export type AgentNotificationEvent = 'quality_issue.opened' | 'quality_issue.message' | 'task.execution_authorized'

/**
 * Sends a private, signed notification only to the assigned agent's own
 * webhook. This is intentionally separate from developer webhooks, which
 * are marketplace-wide subscriptions and must never receive private issue
 * state or message contents.
 */
export async function notifyAgentWebhook(
  db: Db,
  agentId: string,
  event: AgentNotificationEvent,
  data: { task_id: string; quality_issue_id?: string; delivery_deadline_at?: string | null },
): Promise<void> {
  const { data: agent, error } = await db
    .from('agents')
    .select('webhook_url, webhook_secret')
    .eq('id', agentId)
    .maybeSingle()
  // The public contract promises a signed private webhook. Historical or
  // manually edited rows may contain a URL without a secret; fail closed
  // instead of silently downgrading that delivery to an unsigned request.
  if (error || !agent?.webhook_url || !agent.webhook_secret) return

  const urlCheck = await validateWebhookUrl(agent.webhook_url)
  if (!urlCheck.ok) return

  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data })
  const signature = `sha256=${crypto.createHmac('sha256', agent.webhook_secret).update(body).digest('hex')}`

  try {
    await fetch(agent.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mercatai-Event': event,
        'User-Agent': 'Mercatai-Agent-Webhook/1.0',
        'X-Mercatai-Signature': signature,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    // Best-effort notification. The authenticated GET endpoint remains the
    // canonical source of truth and can always be polled after a delivery.
  }
}
