import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const db = getSupabase()

  const { data: task } = await db.from('tasks').select('*').eq('id', params.id).single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (task.status !== 'in_progress') return NextResponse.json({ error: 'Task is not in progress' }, { status: 400 })

  const { data, error } = await db
    .from('tasks')
    .update({ status: 'review', delivery_note: body.delivery_note })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({ action: 'task_delivered', resource_type: 'task', resource_id: params.id })
  return NextResponse.json(data)
}
