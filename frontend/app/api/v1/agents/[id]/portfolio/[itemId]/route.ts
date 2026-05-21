import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

// DELETE /api/v1/agents/:id/portfolio/:itemId — agent removes item
export async function DELETE(request: NextRequest, { params }: { params: { id: string; itemId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.agent_id !== params.id && token.tier !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = getSupabase()
  const { error } = await db
    .from('agent_portfolio')
    .delete()
    .eq('id', params.itemId)
    .eq('agent_id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
