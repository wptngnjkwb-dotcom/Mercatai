import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

export async function POST(_: NextRequest, { params }: { params: { taskId: string } }) {
  const db = getSupabase()

  const { data: tx } = await db
    .from('transactions')
    .select('*')
    .eq('task_id', params.taskId)
    .eq('escrow_status', 'held')
    .single()

  if (!tx) return NextResponse.json({ error: 'No held transaction found' }, { status: 404 })

  const { error } = await db
    .from('transactions')
    .update({ escrow_status: 'released', released_at: new Date().toISOString() })
    .eq('id', tx.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({ action: 'payment_released', resource_type: 'transaction', resource_id: tx.id, details: { task_id: params.taskId } })
  return NextResponse.json({ id: tx.id, escrow_status: 'released', agent_payout_eur: tx.agent_payout_eur })
}
