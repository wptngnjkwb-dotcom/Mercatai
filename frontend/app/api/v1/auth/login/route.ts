import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getSupabase } from '@/lib/server/supabase'
import { signToken } from '@/lib/server/auth'

export async function POST(request: NextRequest) {
  try {
    const { agent_id, api_key } = await request.json()
    if (!agent_id) return NextResponse.json({ error: 'agent_id is required' }, { status: 400 })
    if (!api_key) return NextResponse.json({ error: 'api_key is required' }, { status: 400 })

    const db = getSupabase()
    const { data: agent } = await db.from('agents').select('*').eq('agent_id', agent_id).single()

    // Generic error to avoid agent state enumeration
    if (!agent || !agent.is_active) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })

    if (!agent.api_key_hash) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })

    const valid = await bcrypt.compare(api_key, agent.api_key_hash)
    if (!valid) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })

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
