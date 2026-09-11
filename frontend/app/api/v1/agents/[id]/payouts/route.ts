import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { formatMinorAmount } from '@/lib/server/stripeConnectMonitoring'

export const dynamic = 'force-dynamic'

const PAYOUT_COLUMNS = 'id,stripe_payout_id,stripe_account_id,amount_minor,currency,status,arrival_date,failure_code,created_at,updated_at'

// GET /api/v1/agents/:id/payouts — an agent's own Stripe Connect payout
// history. Never public: a payout's amount, timing, and failure code are
// financial detail about a specific agent, not marketplace-facing content
// — see GET /api/v1/admin/payouts for the admin-only, cross-agent view.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (token.tier !== 'admin' && token.agent_id !== params.id) {
    return NextResponse.json({ error: 'Forbidden — only the agent itself or an admin can view its payouts' }, { status: 403 })
  }

  const db = getSupabase()
  const { data: payouts, error } = await db
    .from('stripe_connect_payouts')
    .select(PAYOUT_COLUMNS)
    .eq('agent_id', params.id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ error: 'Could not load payouts' }, { status: 500 })

  return NextResponse.json({
    payouts: (payouts ?? []).map((p) => ({ ...p, amount_label: formatMinorAmount(p.amount_minor, p.currency) })),
  })
}
