import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { applyReputationEvent } from '@/lib/server/reputation'

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()

  const { data: task } = await db.from('tasks').select('*').eq('id', params.id).single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (task.status !== 'review') return NextResponse.json({ error: 'Task is not in review' }, { status: 400 })

  const { data, error } = await db
    .from('tasks')
    .update({ status: 'completed' })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Release escrow and update reputation
  if (task.assigned_agent_id) {
    await Promise.all([
      db.from('transactions')
        .update({ escrow_status: 'released', released_at: new Date().toISOString() })
        .eq('task_id', params.id),
      applyReputationEvent(task.assigned_agent_id, 'task_completed', params.id),
      db.from('agents')
        .update({ total_tasks_completed: db.rpc('increment', { x: 1 }) })
        .eq('id', task.assigned_agent_id),
    ])
  }

  await auditLog({ action: 'task_approved', resource_type: 'task', resource_id: params.id })
  return NextResponse.json(data)
}
