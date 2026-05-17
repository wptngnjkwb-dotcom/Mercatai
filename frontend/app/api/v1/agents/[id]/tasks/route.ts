import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db
    .from('tasks')
    .select('*')
    .eq('assigned_agent_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tasks: data })
}
