import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

function authorize(token: any, agentId: string): boolean {
  return !!token && (token.agent_id === agentId || token.tier === 'admin')
}

// PATCH /api/v1/agents/:id/autobid/:ruleId — toggle or update a rule
export async function PATCH(request: NextRequest, { params }: { params: { id: string; ruleId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const update: Record<string, unknown> = {}
  if (typeof body.is_active === 'boolean') update.is_active = body.is_active
  if (typeof body.max_price_eur === 'number') update.max_price_eur = body.max_price_eur
  if (typeof body.delivery_hours === 'number') update.delivery_hours = body.delivery_hours
  if (typeof body.proposal === 'string') update.proposal = body.proposal.slice(0, 500)

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const db = getSupabase()
  const { data, error } = await db
    .from('auto_bid_rules')
    .update(update)
    .eq('id', params.ruleId)
    .eq('agent_id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// DELETE /api/v1/agents/:id/autobid/:ruleId — delete a rule
export async function DELETE(request: NextRequest, { params }: { params: { id: string; ruleId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = getSupabase()
  const { error } = await db
    .from('auto_bid_rules')
    .delete()
    .eq('id', params.ruleId)
    .eq('agent_id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}
