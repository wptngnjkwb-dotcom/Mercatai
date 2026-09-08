import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export const dynamic = 'force-dynamic'

// Public catalog of productized agent services.
export async function GET(request: NextRequest) {
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category')

  // A private agent's listings are excluded the same way a suspended
  // agent's already are — filtering on the joined agents row, not just
  // agent_listings.is_active. See frontend/lib/server/agentVisibility.ts.
  let query = db
    .from('agent_listings')
    .select('id,title,description,category,price_eur,delivery_hours,hires_count,created_at,agents!inner(id,agent_id,display_name,reputation_score,success_rate,total_tasks_completed,is_active)')
    .eq('is_active', true)
    .eq('agents.is_active', true)
    .eq('agents.profile_visibility', 'public')
  if (category) query = query.eq('category', category)

  const { data, error } = await query.order('created_at', { ascending: false }).limit(100)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ listings: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

// Create a listing — the agent offering the service, identified by its token.
export async function POST(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  const agentId = typeof token?.agent_id === 'string' ? token.agent_id : null
  if (!agentId) return NextResponse.json({ error: 'Authenticate as an agent to create a listing' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { title, description, category, price_eur, delivery_hours } = body

  if (!title || typeof price_eur !== 'number') {
    return NextResponse.json({ error: 'title and price_eur are required' }, { status: 400 })
  }
  if (price_eur < 1 || price_eur > 10_000) {
    return NextResponse.json({ error: 'price_eur must be between 1 and 10000' }, { status: 400 })
  }

  const db = getSupabase()

  // A private agent isn't discoverable at all, so a Store listing it
  // created could never actually be found — reject the creation outright
  // rather than silently accepting one that would never appear anywhere.
  const { data: creatingAgent, error: agentError } = await db
    .from('agents')
    .select('profile_visibility, is_active')
    .eq('id', agentId)
    .single()
  if (agentError || !creatingAgent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  if (!creatingAgent.is_active) {
    return NextResponse.json({ error: 'Inactive agent cannot create a Store listing' }, { status: 403 })
  }
  if (creatingAgent.profile_visibility !== 'public') {
    return NextResponse.json({ error: 'A private agent cannot create a public Store listing. Switch your profile to public first.' }, { status: 403 })
  }

  // Keep the catalog manageable: max 5 active listings per agent
  const { count } = await db
    .from('agent_listings')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('is_active', true)
  if ((count ?? 0) >= 5) {
    return NextResponse.json({ error: 'Maximum of 5 active listings per agent' }, { status: 400 })
  }

  const { data, error } = await db
    .from('agent_listings')
    .insert({
      agent_id: agentId,
      title,
      description: description || '',
      category: category || null,
      price_eur,
      delivery_hours: delivery_hours || 24,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({ action: 'listing_created', resource_type: 'listing', resource_id: data.id, agent_id: agentId, details: { title, price_eur } })
  return NextResponse.json(data, { status: 201 })
}
