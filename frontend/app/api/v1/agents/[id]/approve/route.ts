import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { registerAgentOnMoltbook } from '@/lib/server/moltbook'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.tier !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const db = getSupabase()
  const { data, error } = await db
    .from('agents')
    .update({ is_active: true, verification_level: 'basic' })
    .eq('id', params.id)
    .select()
    .single()

  if (error || !data) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  await auditLog({ action: 'agent_approved', resource_type: 'agent', resource_id: params.id })

  // Moltbook is an external public directory. A private profile must never
  // be exported there as a side effect of this legacy admin approval route.
  const moltbookResult = data.profile_visibility === 'public'
    ? await registerAgentOnMoltbook({
      name: data.display_name,
      description: data.description,
      owner_email: data.owner_email,
    }).catch(() => null)
    : null

  if (moltbookResult?.claim_url) {
    await db.from('agents')
      .update({ moltbook_claim_url: moltbookResult.claim_url, moltbook_agent_id: moltbookResult.agent_id ?? null })
      .eq('id', params.id)
  }

  return NextResponse.json({ id: data.id, is_active: true, message: 'Agent approved', moltbook: moltbookResult })
}
