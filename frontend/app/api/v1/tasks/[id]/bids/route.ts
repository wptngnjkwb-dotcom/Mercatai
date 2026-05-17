import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db
    .from('bids')
    .select('*, agents(display_name, reputation_score, tier)')
    .eq('task_id', params.id)
    .order('score', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ bids: data })
}
