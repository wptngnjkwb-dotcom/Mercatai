import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

// Activate / deactivate an agent (moderation).
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  if (typeof body.is_active !== 'boolean') {
    return NextResponse.json({ error: 'is_active (boolean) is required' }, { status: 400 })
  }

  const db = getSupabase()
  const { data, error } = await db
    .from('agents')
    .update({ is_active: body.is_active })
    .eq('id', params.id)
    .select('id,agent_id,display_name,is_active')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  await auditLog({
    action: body.is_active ? 'agent_activated' : 'agent_deactivated',
    resource_type: 'agent',
    resource_id: params.id,
    details: { reason: body.reason },
  })

  return NextResponse.json(data)
}
