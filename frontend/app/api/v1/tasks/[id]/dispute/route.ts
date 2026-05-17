import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}))
  const db = getSupabase()

  const { data, error } = await db
    .from('tasks')
    .update({ status: 'disputed' })
    .eq('id', params.id)
    .select()
    .single()

  if (error || !data) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  await auditLog({
    action: 'task_disputed',
    resource_type: 'task',
    resource_id: params.id,
    details: { reason: body.reason },
  })

  return NextResponse.json(data)
}
