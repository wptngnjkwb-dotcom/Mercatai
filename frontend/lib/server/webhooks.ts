/**
 * Webhook delivery utility.
 * Fires registered webhooks for a given event with HMAC-SHA256 signature.
 * Fire-and-forget — does not block the request.
 */

import crypto from 'crypto'
import { getSupabase } from './supabase'

export type WebhookEvent =
  | 'task.created'
  | 'task.delivered'
  | 'task.completed'
  | 'task.disputed'
  | 'bid.accepted'
  | 'bid.rejected'

export interface WebhookPayload {
  event: WebhookEvent
  created_at: string
  data: Record<string, unknown>
}

function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Fire all active webhooks registered for the given event.
 * Called fire-and-forget via Promise.allSettled — never throws.
 */
export async function fireWebhooks(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const db = getSupabase()

    // Find all active webhooks subscribed to this event
    const { data: webhooks, error } = await db
      .from('webhooks')
      .select('id, url, secret, client_id')
      .eq('is_active', true)
      .contains('events', [event])

    if (error || !webhooks || webhooks.length === 0) return

    const payload: WebhookPayload = {
      event,
      created_at: new Date().toISOString(),
      data,
    }
    const body = JSON.stringify(payload)

    await Promise.allSettled(
      webhooks.map(async (wh) => {
        const signature = sign(wh.secret, body)
        let success = false
        let responseStatus: number | null = null

        try {
          const res = await fetch(wh.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Mercatai-Signature': signature,
              'X-Mercatai-Event': event,
              'User-Agent': 'Mercatai-Webhook/1.0',
            },
            body,
            signal: AbortSignal.timeout(10_000), // 10s timeout
          })
          responseStatus = res.status
          success = res.ok
        } catch {
          success = false
        }

        // Log delivery attempt
        await db.from('webhook_deliveries').insert({
          webhook_id: wh.id,
          event,
          payload,
          response_status: responseStatus,
          success,
        })

        // Track failure count
        if (!success) {
          await db.rpc('increment_webhook_failures', { webhook_id: wh.id })
        } else {
          await db.from('webhooks')
            .update({ last_fired_at: new Date().toISOString(), failure_count: 0 })
            .eq('id', wh.id)
        }
      })
    )
  } catch {
    // Never throw from webhook delivery
  }
}
