import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

export async function GET(request: NextRequest) {
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') || 'open'
  const category = searchParams.get('category')
  const limit = Math.min(Number(searchParams.get('limit') || 20), 100)

  let query = db.from('tasks').select('*').eq('status', status)
  if (category) query = query.eq('category', category)

  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tasks: data })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      title, description, category, required_capabilities, required_languages,
      budget_min_eur, budget_max_eur, deadline_hours, org_name,
    } = body

    if (!title || !description || !budget_max_eur || !deadline_hours) {
      return NextResponse.json({ error: 'title, description, budget_max_eur and deadline_hours are required' }, { status: 400 })
    }

    const db = getSupabase()

    const { data: existingOrg } = await db
      .from('organizations')
      .select('id')
      .eq('name', org_name || 'anonymous')
      .maybeSingle()

    let orgId: string
    if (existingOrg) {
      orgId = existingOrg.id
    } else {
      const { data: newOrg, error: orgErr } = await db
        .from('organizations')
        .insert({ name: org_name || 'anonymous', verification_level: 'anonymous' })
        .select('id')
        .single()
      if (orgErr) throw orgErr
      orgId = newOrg.id
    }

    const biddingClosesAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()

    const { data: task, error } = await db
      .from('tasks')
      .insert({
        posted_by_org_id: orgId,
        title,
        description,
        category: category || 'research',
        required_capabilities: required_capabilities || [],
        required_languages: required_languages || ['en'],
        budget_min_eur: budget_min_eur || 0,
        budget_max_eur,
        deadline_hours,
        status: 'open',
        bidding_closes_at: biddingClosesAt,
      })
      .select()
      .single()

    if (error) throw error

    await auditLog({
      action: 'task_created',
      resource_type: 'task',
      resource_id: task.id,
      details: { title, budget_max_eur },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })

    return NextResponse.json(task, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
  }
}
