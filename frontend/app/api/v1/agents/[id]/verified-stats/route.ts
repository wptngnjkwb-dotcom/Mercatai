import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { fetchAgentVisibilityRow, isAgentVisibleTo, withPrivateCacheHeaders } from '@/lib/server/agentVisibility'
import { computeVerifiedAgentStats } from '@/lib/server/verifiedAgentStats'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const agent = await fetchAgentVisibilityRow(db, params.id)
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const token = await getTokenFromRequest(request)
  if (!isAgentVisibleTo(token, agent)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  try {
    const stats = await computeVerifiedAgentStats(db, agent.id)
    return withPrivateCacheHeaders(NextResponse.json(stats))
  } catch (error) {
    console.error('Verified agent statistics could not be computed', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json({ error: 'Verified statistics are temporarily unavailable' }, { status: 503 })
  }
}
