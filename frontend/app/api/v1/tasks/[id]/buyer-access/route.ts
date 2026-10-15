import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getSupabase } from '@/lib/server/supabase'
import { signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { clientIp, isRateLimited } from '@/lib/server/rateLimit'
import { sendBuyerAccessRecovery } from '@/lib/server/email'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GENERIC_RESPONSE = {
  message: 'If that email matches this task, Mercatai will send a buyer-access link shortly.',
}

async function processBuyerAccessRequest(taskId: string, email: string) {
  const db = getSupabase()
  const { data: task, error } = await db
    .from('tasks')
    .select('id,title,buyer_email,posted_by_org_id,archived_at')
    .eq('id', taskId)
    .maybeSingle()

  // Missing task, DB read failure, archived task and an email mismatch all
  // end silently after the caller has received the identical public 202.
  if (error || !task || task.archived_at || typeof task.buyer_email !== 'string'
      || task.buyer_email.trim().toLowerCase() !== email) return

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
    // Never log the token-bearing event or the recipient address.
    console.error(
      '[buyer-access] recovery delivery failed',
      recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
    )
  }
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

  // Identity lookup, token creation and email delivery run after the public
  // response. Matching and non-matching requests therefore have the same
  // response shape and do not reveal a match through provider latency.
  waitUntil(processBuyerAccessRequest(params.id, email).catch((backgroundError) => {
    console.error(
      '[buyer-access] background processing failed',
      backgroundError instanceof Error ? backgroundError.message : String(backgroundError),
    )
  }))

  return NextResponse.json(GENERIC_RESPONSE, { status: 202 })
}
