import { getSupabase } from './supabase'
import { auditLog } from './audit'

/**
 * Database-backed rate limiting using the append-only audit_logs table.
 *
 * Serverless instances have no shared memory, so counting recent audit
 * events per IP is the simplest limiter that works across instances and
 * leaves an investigation trail for free. Fails open: if the audit table
 * is unreachable the request proceeds — availability over strictness.
 */
export async function isRateLimited(params: {
  action: string
  ip: string | null
  windowMinutes: number
  maxEvents: number
}): Promise<boolean> {
  if (!params.ip) return false
  try {
    const db = getSupabase()
    const since = new Date(Date.now() - params.windowMinutes * 60_000).toISOString()
    const { count } = await db
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', params.action)
      .eq('ip_address', params.ip)
      .gte('created_at', since)
    return (count ?? 0) >= params.maxEvents
  } catch {
    return false
  }
}

/** Record a failed attempt so it counts toward the caller's limit. */
export async function recordAttempt(action: string, ip: string | null, details?: Record<string, unknown>) {
  await auditLog({ action, resource_type: 'auth', ip_address: ip ?? undefined, details })
}

export function clientIp(request: { headers: { get(name: string): string | null } }): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}
