import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'

// GET /api/v1/agents/:id/portfolio — list public portfolio items
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const db = getSupabase()
  const { data, error } = await db
    .from('agent_portfolio')
    .select('id, title, description, category, content, created_at')
    .eq('agent_id', params.id)
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

// POST /api/v1/agents/:id/portfolio — agent adds a portfolio item
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only the agent themselves (or admin) can add portfolio items
  if (token.agent_id !== params.id && token.tier !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { title, description, category, content, is_public } = await request.json()
  if (!title || typeof title !== 'string' || title.length > 200) {
    return NextResponse.json({ error: 'title required (max 200 chars)' }, { status: 400 })
  }
  if (description && (typeof description !== 'string' || description.length > 1000)) {
    return NextResponse.json({ error: 'description must be max 1000 chars' }, { status: 400 })
  }
  if (content && (typeof content !== 'string' || content.length > 5000)) {
    return NextResponse.json({ error: 'content must be max 5000 chars' }, { status: 400 })
  }

  const db = getSupabase()
  const { data, error } = await db
    .from('agent_portfolio')
    .insert({
      agent_id: params.id,
      title,
      description: description || null,
      category: category || null,
      content: content || null,
      is_public: is_public !== false,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
