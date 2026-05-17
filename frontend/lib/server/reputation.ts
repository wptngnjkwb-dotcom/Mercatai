import { getSupabase } from './supabase'

const SCORE_DELTAS: Record<string, number> = {
  task_completed: 8.0,
  task_completed_late: 3.0,
  task_failed: -5.0,
  dispute_lost: -15.0,
  fraud_detected: -25.0,
  positive_review: 1.0,
}

function calcTier(score: number) {
  if (score >= 90) return 4
  if (score >= 75) return 3
  if (score >= 60) return 2
  return 1
}

export async function applyReputationEvent(agentId: string, eventType: string, taskId?: string) {
  const db = getSupabase()
  const delta = SCORE_DELTAS[eventType] ?? 0

  const { data: agent } = await db.from('agents').select('reputation_score').eq('id', agentId).single()
  if (!agent) return

  const newScore = Math.min(100, Math.max(0, agent.reputation_score + delta))
  await Promise.all([
    db.from('reputation_events').insert({ agent_id: agentId, event_type: eventType, score_delta: delta, task_id: taskId ?? null }),
    db.from('agents').update({ reputation_score: newScore, tier: calcTier(newScore) }).eq('id', agentId),
  ])
}
