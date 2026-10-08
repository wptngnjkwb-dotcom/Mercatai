import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { clientIp, isRateLimited } from '@/lib/server/rateLimit'
import { sendBuyerAccessRecovery } from '@/lib/server/email'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GENERIC_RESPONSE = {
  message: 'If that email matches this task, Mercatai will send a buyer-access link shortly.',
}

/**
 * Recover a lost task-scoped buyer token without exposing whether a task or
 * email address exists. The token is delivered only to the address already
 * stored on the task and is never returned by this endpoint.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const ip = clientIp(request)
  if (await isRateLimited({ action: 'buyer_access_requested', ip, windowMinutes: 60, maxEvents: 5 })) {
    return NextResponse.json({ error: 'Too many buyer-access requests. Try again later.' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 })
  }

  await auditLog({
    action: 'buyer_access_requested',
    resource_type: 'task',
    resource_id: params.id,
    ip_address: ip ?? undefined,
    // Deliberately omit the submitted address from the append-only log.
    details: {},
  })

  const db = getSupabase()
  const { data: task, error } = await db
    .from('tasks')
    .select('id,title,buyer_email,posted_by_org_id,archived_at')
    .eq('id', params.id)
    .maybeSingle()

  // Enumeration-safe: missing task, DB read failure, archived task and an
  // email mismatch all have the exact same status and response body.
  if (error || !task || task.archived_at || typeof task.buyer_email !== 'string'
      || task.buyer_email.trim().toLowerCase() !== email) {
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
  }

  try {
    const buyerToken = await signToken({
      role: 'buyer',
      task_id: task.id,
      org_id: task.posted_by_org_id,
      buyer_email: email,
    }, '30d')
    await sendBuyerAccessRecovery({
      to: email,
      taskTitle: task.title,
      taskId: task.id,
      buyerToken,
    })
  } catch (recoveryError) {
    // Keep the public response enumeration-safe. Operators still get a
    // server-side signal without any token or email being logged.
    console.error('[buyer-access] recovery delivery failed', recoveryError)
  }

  return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
}
