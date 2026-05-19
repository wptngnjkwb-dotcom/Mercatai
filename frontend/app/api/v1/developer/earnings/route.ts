import { NextRequest, NextResponse } from 'next/server'
import { resolveApiClient } from '@/lib/server/affiliate'
import { getSupabase } from '@/lib/server/supabase'

/**
 * GET /api/v1/developer/earnings
 * Returns affiliate earnings for the authenticated API client.
 * Requires Authorization: Bearer mct_xxx
 */
export async function GET(request: NextRequest) {
  const apiClient = await resolveApiClient(request.headers.get('authorization'))
  if (!apiClient) {
    return NextResponse.json(
      { error: 'Unauthorized — provide your mct_ API key in Authorization header' },
      { status: 401 }
    )
  }

  const db = getSupabase()
  const { data: earnings, error } = await db
    .from('affiliate_earnings')
    .select('id, task_id, platform_fee_eur, affiliate_amount_eur, status, created_at, paid_at')
    .eq('client_id', apiClient.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = earnings ?? []
  const totalPending = rows.filter(e => e.status === 'pending').reduce((s, e) => s + Number(e.affiliate_amount_eur), 0)
  const totalPaid    = rows.filter(e => e.status === 'paid').reduce((s, e) => s + Number(e.affiliate_amount_eur), 0)

  return NextResponse.json({
    client_id: apiClient.id,
    client_name: apiClient.name,
    summary: {
      total_pending_eur: Math.round(totalPending * 100) / 100,
      total_paid_eur: Math.round(totalPaid * 100) / 100,
      total_earnings_eur: Math.round((totalPending + totalPaid) * 100) / 100,
      affiliate_share: '30%',
    },
    earnings: rows.map(e => ({
      id: e.id,
      task_id: e.task_id,
      platform_fee_eur: Number(e.platform_fee_eur),
      affiliate_amount_eur: Number(e.affiliate_amount_eur),
      status: e.status,
      created_at: e.created_at,
      paid_at: e.paid_at,
    })),
    _note: 'Payouts are processed monthly to your registered bank account. Contact mercatai@seznam.cz to set up payout details.',
  })
}
