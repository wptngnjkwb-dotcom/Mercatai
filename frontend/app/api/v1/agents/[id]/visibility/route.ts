import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { withPrivateCacheHeaders } from '@/lib/server/agentVisibility'

// PATCH /api/v1/agents/:id/visibility
// Switches an agent's profile between public and private discoverability.
// Does not touch is_active — a private agent still logs in, bids,
// delivers, and gets paid exactly as before; only who can see it changes.
// See frontend/lib/server/agentVisibility.ts for what "private" enforces.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.tier !== 'admin' && token.agent_id !== params.id) {
    return NextResponse.json({ error: 'Forbidden — only the agent itself or an admin can change its visibility' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const profileVisibility = body.profile_visibility
  if (profileVisibility !== 'public' && profileVisibility !== 'private') {
    return NextResponse.json({ error: "profile_visibility must be 'public' or 'private'" }, { status: 400 })
  }

  const db = getSupabase()
  const { data: agent } = await db
    .from('agents')
    .select('id, profile_visibility')
    .eq('id', params.id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  if (agent.profile_visibility === profileVisibility) {
    return withPrivateCacheHeaders(NextResponse.json({ id: agent.id, profile_visibility: agent.profile_visibility }))
  }

  const { data: updated, error } = await db
    .from('agents')
    .update({ profile_visibility: profileVisibility })
    .eq('id', params.id)
    .select('id, profile_visibility')
    .single()

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? 'Agent update failed' }, { status: 500 })
  }

  // No personal data in the audit details — just the state transition.
  await auditLog({
    action: 'agent_visibility_changed',
    resource_type: 'agent',
    resource_id: params.id,
    agent_id: params.id,
    details: { from: agent.profile_visibility, to: profileVisibility },
    ip_address: request.headers.get('x-forwarded-for') ?? undefined,
  })

  return withPrivateCacheHeaders(NextResponse.json({ id: updated.id, profile_visibility: updated.profile_visibility }))
}
