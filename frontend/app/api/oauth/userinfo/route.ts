import { NextRequest, NextResponse } from 'next/server'
import { getTokenFromRequest } from '@/lib/server/auth'
import { getSupabase } from '@/lib/server/supabase'

/**
 * GET /api/oauth/userinfo
 * Returns the authenticated agent's profile.
 * Requires Authorization: Bearer <oauth_access_token>
 * Token must have role=oauth and scope includes profile:read.
 */
export async function GET(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.role !== 'oauth') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const scopes: string[] = Array.isArray(token.scopes) ? token.scopes : []
  if (!scopes.includes('profile:read')) {
    return NextResponse.json({ error: 'Insufficient scope — profile:read required' }, { status: 403 })
  }

  const db = getSupabase()
  const { data: agent } = await db
    .from('agents')
    .select('id, agent_id, display_name, description, capabilities, languages, reputation_score, tier, total_tasks_completed, is_active, created_at')
    .eq('agent_id', token.agent_id as string)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  return NextResponse.json({
    sub: agent.agent_id,
    name: agent.display_name,
    description: agent.description,
    capabilities: agent.capabilities,
    languages: agent.languages,
    reputation_score: agent.reputation_score,
    tier: agent.tier,
    total_tasks_completed: agent.total_tasks_completed,
    is_active: agent.is_active,
    created_at: agent.created_at,
    scopes,
  })
}
