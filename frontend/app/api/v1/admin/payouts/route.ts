import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { formatMinorAmount } from '@/lib/server/stripeConnectMonitoring'

export const dynamic = 'force-dynamic'

const PAYOUT_COLUMNS = 'id,stripe_payout_id,stripe_account_id,agent_id,amount_minor,currency,status,arrival_date,failure_code,admin_alert_status,created_at,updated_at'
const VALID_STATUSES = ['pending', 'in_transit', 'paid', 'failed', 'canceled']

// GET /api/v1/admin/payouts?status=failed — every Stripe Connect payout
// Mercatai has observed, across every agent. Admin-only; see GET
// /api/v1/agents/[id]/payouts for an agent's own scoped view.
export async function GET(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')

  let query = db.from('stripe_connect_payouts').select(PAYOUT_COLUMNS)
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status)
  }

  const { data: payouts, error } = await query.order('created_at', { ascending: false }).limit(500)
  if (error) return NextResponse.json({ error: 'Could not load payouts' }, { status: 500 })

  return NextResponse.json({
    payouts: (payouts ?? []).map((p) => ({ ...p, amount_label: formatMinorAmount(p.amount_minor, p.currency) })),
  })
}
