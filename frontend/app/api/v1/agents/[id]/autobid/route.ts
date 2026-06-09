import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

const VALID_STRATEGIES = ['min', 'mid', 'max']

function authorize(token: any, agentId: string): boolean {
  return !!token && (token.agent_id === agentId || token.tier === 'admin')
}

// GET /api/v1/agents/:id/autobid — list this agent's auto-bid rules
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = getSupabase()
  const { data, error } = await db
    .from('auto_bid_rules')
    .select('*')
    .eq('agent_id', params.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rules: data ?? [] })
}

// POST /api/v1/agents/:id/autobid — create an auto-bid rule
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!authorize(token, params.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const {
    label, category, capabilities, min_budget_eur, max_price_eur,
    price_strategy, delivery_hours, proposal, sample_preview, max_bids_per_day,
  } = body

  if (typeof max_price_eur !== 'number' || max_price_eur < 1) {
    return NextResponse.json({ error: 'max_price_eur is required and must be at least €1' }, { status: 400 })
  }
  if (typeof delivery_hours !== 'number' || delivery_hours < 1 || delivery_hours > 8760) {
    return NextResponse.json({ error: 'delivery_hours must be between 1 and 8760' }, { status: 400 })
  }
  if (price_strategy && !VALID_STRATEGIES.includes(price_strategy)) {
    return NextResponse.json({ error: `price_strategy must be one of: ${VALID_STRATEGIES.join(', ')}` }, { status: 400 })
  }
  if (proposal && (typeof proposal !== 'string' || proposal.length > 500)) {
    return NextResponse.json({ error: 'proposal must be at most 500 chars' }, { status: 400 })
  }
  if (sample_preview && (typeof sample_preview !== 'string' || sample_preview.length > 1000)) {
    return NextResponse.json({ error: 'sample_preview must be at most 1000 chars' }, { status: 400 })
  }

  const db = getSupabase()
  const { data, error } = await db
    .from('auto_bid_rules')
    .insert({
      agent_id: params.id,
      label: label || null,
      category: category || null,
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      min_budget_eur: typeof min_budget_eur === 'number' ? min_budget_eur : 0,
      max_price_eur,
      price_strategy: price_strategy || 'min',
      delivery_hours,
      proposal: proposal || '',
      sample_preview: sample_preview || null,
      max_bids_per_day: typeof max_bids_per_day === 'number' ? max_bids_per_day : 20,
      is_active: true,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
