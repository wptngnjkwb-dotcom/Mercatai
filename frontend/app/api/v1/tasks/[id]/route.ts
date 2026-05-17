import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db.from('tasks').select('*').eq('id', params.id).single()
  if (error || !data) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  return NextResponse.json(data)
}
