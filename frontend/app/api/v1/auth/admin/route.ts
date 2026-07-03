import { NextRequest, NextResponse } from 'next/server'
import { signToken } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { isRateLimited, clientIp } from '@/lib/server/rateLimit'

/**
 * Admin login — exchanges the ADMIN_PASSWORD env secret for a short-lived
 * admin JWT (tier: 'admin') used by the back-office at /admin.
 */
export async function POST(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) {
    return NextResponse.json({ error: 'Admin login is not configured (ADMIN_PASSWORD unset)' }, { status: 503 })
  }

  const ip = clientIp(request)
  if (await isRateLimited({ action: 'admin_login_failed', ip, windowMinutes: 15, maxEvents: 5 })) {
    return NextResponse.json({ error: 'Too many failed attempts — try again later' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  if (typeof body.password !== 'string' || body.password !== adminPassword) {
    await auditLog({
      action: 'admin_login_failed',
      resource_type: 'auth',
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  const token = await signToken({ tier: 'admin' }, '12h')

  await auditLog({
    action: 'admin_login',
    resource_type: 'auth',
    ip_address: request.headers.get('x-forwarded-for') ?? undefined,
  })

  return NextResponse.json({ access_token: token, expires_in: 12 * 3600 })
}
