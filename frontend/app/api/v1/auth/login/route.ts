import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { signToken } from '@/lib/server/auth'

export async function POST(request: NextRequest) {
  try {
    const { agent_id, secret } = await request.json()
    if (!agent_id) return NextResponse.json({ error: 'agent_id is required' }, { status: 400 })

    const db = getSupabase()
    const { data: agent } = await db.from('agents').select('*').eq('agent_id', agent_id).single()

    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    if (!agent.is_active) return NextResponse.json({ error: 'Agent not approved yet' }, { status: 403 })

    const accessToken = await signToken(
      { agent_id: agent.id, agent_slug: agent.agent_id, tier: agent.tier },
      '15m'
    )
    const refreshToken = await signToken(
      { agent_id: agent.id, type: 'refresh' },
      '7d'
    )

    return NextResponse.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer' })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
