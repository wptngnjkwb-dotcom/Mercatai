import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { DEFAULT_PLATFORM_FEE_PERCENT, getPlatformFeePercent } from '@/lib/server/settings'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }
  return NextResponse.json({
    platform_fee_percent: await getPlatformFeePercent(),
    default_platform_fee_percent: DEFAULT_PLATFORM_FEE_PERCENT,
  })
}

export async function PUT(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const fee = Number(body.platform_fee_percent)
  if (!Number.isFinite(fee) || fee < 0 || fee > 50) {
    return NextResponse.json({ error: 'platform_fee_percent must be a number between 0 and 50' }, { status: 400 })
  }

  const db = getSupabase()
  const { error } = await db
    .from('platform_settings')
    .upsert({ key: 'platform_fee_percent', value: String(fee), updated_at: new Date().toISOString() })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({
    action: 'platform_setting_changed',
    resource_type: 'setting',
    details: { key: 'platform_fee_percent', value: fee },
  })

  return NextResponse.json({ platform_fee_percent: fee })
}
