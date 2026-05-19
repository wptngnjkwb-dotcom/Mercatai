import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import bcrypt from 'bcryptjs'
import { getSupabase } from '@/lib/server/supabase'

// Tier labels for human-readable output
const TIER_LABELS: Record<number, string> = {
  1: 'new',
  2: 'trusted',
  3: 'expert',
  4: 'elite',
}

// Simple in-memory rate limit for unauthenticated calls: 60 req/hour per IP
const anonRateLimit = new Map<string, { count: number; resetAt: number }>()

function checkAnonRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = anonRateLimit.get(ip)
  if (entry && now < entry.resetAt) {
    if (entry.count >= 60) return false
    entry.count++
  } else {
    anonRateLimit.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 })
  }
  return true
}

async function resolveApiClient(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer mct_')) return null
  const rawKey = authHeader.slice(7) // strip "Bearer "
  const db = getSupabase()
  const { data: clients } = await db
    .from('api_clients')
    .select('id, name, rate_limit_per_hour, scopes')
    .eq('is_active', true)

  if (!clients) return null
  for (const client of clients) {
    const match = await bcrypt.compare(rawKey, client.key_hash)
    if (match) return client
  }
  return null
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getSupabase()
  const authHeader = request.headers.get('authorization')

  // Authenticated third-party client (mct_ key) — higher limits + full history
  const apiClient = await resolveApiClient(authHeader)

  // Unauthenticated — apply strict rate limit
  if (!apiClient) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    if (!checkAnonRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Authenticate with a mct_ API key for higher limits.' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      )
    }
  }

  // Resolve agent — support both UUID (id) and string (agent_id)
  const idParam = params.id
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idParam)

  const { data: agent, error } = await db
    .from('agents')
    .select('id, agent_id, display_name, reputation_score, tier, success_rate, total_tasks_completed, is_active, created_at')
    .eq(isUuid ? 'id' : 'agent_id', idParam)
    .single()

  if (error || !agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Reputation events — full history for authenticated clients, last 5 for anon
  const historyLimit = apiClient ? 50 : 5
  const { data: events } = await db
    .from('reputation_events')
    .select('event_type, score_delta, task_id, created_at')
    .eq('agent_id', agent.id)
    .order('created_at', { ascending: false })
    .limit(historyLimit)

  // Score trend: last 10 events aggregated
  const trend = (events ?? []).slice(0, 10).reduce((acc, e) => acc + e.score_delta, 0)

  const score = agent.reputation_score ?? 50
  const tier = agent.tier ?? 1

  const response = {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    is_active: agent.is_active,
    reputation: {
      score: Math.round(score * 10) / 10,        // e.g. 87.3
      tier: tier,
      tier_label: TIER_LABELS[tier] ?? 'new',    // "trusted"
      trend_10: Math.round(trend * 10) / 10,     // sum of last 10 deltas — positive = improving
      percentile: scoreToPercentile(score),      // rough percentile
    },
    stats: {
      total_tasks_completed: agent.total_tasks_completed ?? 0,
      success_rate: agent.success_rate ?? null,  // 0.0–1.0
      member_since: agent.created_at,
    },
    recent_events: (events ?? []).map(e => ({
      event_type: e.event_type,
      score_delta: e.score_delta,
      task_id: e.task_id,
      at: e.created_at,
    })),
    _meta: {
      authenticated: !!apiClient,
      client_name: apiClient?.name ?? null,
      history_limit: historyLimit,
      docs: 'https://mercatai.eu/developer',
    },
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  })
}

// Very rough percentile based on score distribution
function scoreToPercentile(score: number): number {
  if (score >= 90) return 95
  if (score >= 80) return 85
  if (score >= 70) return 70
  if (score >= 60) return 50
  if (score >= 50) return 35
  return 15
}
