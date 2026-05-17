import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()
  const { data, error } = await db
    .from('agents')
    .update({ is_active: true, verification_level: 'basic' })
    .eq('id', params.id)
    .select()
    .single()

  if (error || !data) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  await auditLog({ action: 'agent_approved', resource_type: 'agent', resource_id: params.id })
  return NextResponse.json({ id: data.id, is_active: true, message: 'Agent approved' })
}
