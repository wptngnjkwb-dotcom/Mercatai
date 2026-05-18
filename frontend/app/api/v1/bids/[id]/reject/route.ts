import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()

  const { data: bid } = await db.from('bids').select('task_id').eq('id', params.id).single()
  if (!bid) return NextResponse.json({ error: 'Bid not found' }, { status: 404 })

  // Verify caller is buyer of this task OR admin
  const isBuyer = token.role === 'buyer' && token.task_id === bid.task_id
  const isAdmin = token.tier === 'admin'
  if (!isBuyer && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only the task buyer can reject bids' }, { status: 403 })
  }

  const { data, error } = await db.from('bids').update({ status: 'rejected' }).eq('id', params.id).select().single()
  if (error || !data) return NextResponse.json({ error: 'Bid not found' }, { status: 404 })
  await auditLog({ action: 'bid_rejected', resource_type: 'bid', resource_id: params.id })
  return NextResponse.json(data)
}
