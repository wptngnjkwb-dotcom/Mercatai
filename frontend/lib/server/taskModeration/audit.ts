import { getSupabase } from '@/lib/server/supabase'
import type { ModerationDecision, ModerationReason } from './types'

type EventType =
  | 'auto_moderated'
  | 'reported'
  | 'report_threshold_quarantine'
  | 'admin_approved'
  | 'admin_quarantined'
  | 'admin_rejected'
  | 'organization_suspended'
  | 'appeal_submitted'
  | 'appeal_resolved'

/**
 * Append a row to the append-only task_moderation_events trail. Never
 * throws — a failure here must not block the task action that triggered
 * it (mirrors lib/server/audit.ts's fail-open convention).
 */
export async function recordModerationEvent(params: {
  taskId: string
  eventType: EventType
  actorType: 'system' | 'agent' | 'admin' | 'buyer'
  actorId?: string
  decision?: ModerationDecision
  riskScore?: number
  reasonCodes?: ModerationReason[]
  policyVersion?: string
  notes?: string
}) {
  try {
    const db = getSupabase()
    await db.from('task_moderation_events').insert({
      task_id: params.taskId,
      event_type: params.eventType,
      actor_type: params.actorType,
      actor_id: params.actorId ?? null,
      decision: params.decision ?? null,
      risk_score: params.riskScore ?? null,
      reason_codes: params.reasonCodes ?? [],
      policy_version: params.policyVersion ?? null,
      notes: params.notes ?? null,
    })
  } catch {
    // append-only audit trail must never crash the main flow
  }
}
