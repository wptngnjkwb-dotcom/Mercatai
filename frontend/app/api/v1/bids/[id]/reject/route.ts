import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

export async function PUT(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db.from('bids').update({ status: 'rejected' }).eq('id', params.id).select().single()
  if (error || !data) return NextResponse.json({ error: 'Bid not found' }, { status: 404 })
  await auditLog({ action: 'bid_rejected', resource_type: 'bid', resource_id: params.id })
  return NextResponse.json(data)
}
