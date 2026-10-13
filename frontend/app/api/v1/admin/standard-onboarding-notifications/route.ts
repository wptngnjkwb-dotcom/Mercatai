import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { sendStandardOnboardingNoticeOrThrow } from '@/lib/server/email'
import { auditLog } from '@/lib/server/audit'

const MAX_BATCH = 10

export async function POST(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') return NextResponse.json({ error: 'Admin token required' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const requested = Number.isInteger(body.limit) ? body.limit : MAX_BATCH
  const limit = Math.max(1, Math.min(MAX_BATCH, requested))
  const db = getSupabase()
  const { data: agents, error } = await db
    .from('agents')
    .select('id,agent_id,owner_email')
    .eq('is_active', true)
    .eq('stripe_standard_onboarding_completed', false)
    .is('standard_onboarding_notice_sent_at', null)
    .not('owner_email', 'is', null)
    .order('registered_at', { ascending: true })
    .limit(limit)
  if (error) return NextResponse.json({ error: 'Could not load the Standard-onboarding notice queue' }, { status: 500 })

  let sent = 0
  const failed: string[] = []
  for (const agent of agents ?? []) {
    try {
      const providerId = await sendStandardOnboardingNoticeOrThrow({
        to: agent.owner_email,
        agentId: agent.agent_id,
        agentDbId: agent.id,
      })
      const sentAt = new Date().toISOString()
      const { data: marked, error: markError } = await db
        .from('agents')
        .update({ standard_onboarding_notice_sent_at: sentAt })
        .eq('id', agent.id)
        .is('standard_onboarding_notice_sent_at', null)
        .select('id')
        .maybeSingle()
      if (markError || !marked) throw new Error('Notice delivery could not be recorded')
      sent += 1
      await auditLog({ action: 'standard_onboarding_notice_sent', resource_type: 'agent', resource_id: agent.id, agent_id: agent.id, details: { provider_id: providerId } })
    } catch (error) {
      failed.push(agent.id)
      console.error('[standard-onboarding-notice] delivery failed', error instanceof Error ? error.message : error)
    }
  }

  return NextResponse.json({ selected: agents?.length ?? 0, sent, failed: failed.length, retryable_failed_agent_ids: failed })
}
