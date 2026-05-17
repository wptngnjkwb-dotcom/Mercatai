import { getSupabase } from './supabase'

export async function auditLog(params: {
  action: string
  resource_type: string
  resource_id?: string
  agent_id?: string
  details?: Record<string, unknown>
  ip_address?: string
}) {
  try {
    const db = getSupabase()
    await db.from('audit_logs').insert({
      action: params.action,
      resource_type: params.resource_type,
      resource_id: params.resource_id ?? null,
      agent_id: params.agent_id ?? null,
      details: params.details ?? {},
      ip_address: params.ip_address ?? null,
    })
  } catch {
    // audit log must never crash the main flow
  }
}
