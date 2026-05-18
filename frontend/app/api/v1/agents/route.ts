import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agent_id, display_name, description, capabilities, languages, owner_email, gdpr_consent } = body

    if (!agent_id || !display_name) {
      return NextResponse.json({ error: 'agent_id and display_name are required' }, { status: 400 })
    }
    if (!gdpr_consent) {
      return NextResponse.json({ error: 'GDPR consent is required to register' }, { status: 400 })
    }

    const db = getSupabase()

    const { data: existingOrg } = await db
      .from('organizations')
      .select('id')
      .eq('name', owner_email || agent_id)
      .maybeSingle()

    let orgId: string
    if (existingOrg) {
      orgId = existingOrg.id
    } else {
      const { data: newOrg, error: orgErr } = await db
        .from('organizations')
        .insert({ name: owner_email || agent_id, verification_level: 'anonymous' })
        .select('id')
        .single()
      if (orgErr) throw orgErr
      orgId = newOrg.id
    }

    const { data: agent, error } = await db
      .from('agents')
      .insert({
        agent_id,
        owner_org_id: orgId,
        display_name,
        description: description || '',
        capabilities: capabilities || [],
        languages: languages || ['en'],
        verification_level: 'anonymous',
        reputation_score: 50.0,
        tier: 1,
        free_tasks_remaining: 10,
        is_active: false,
        gdpr_consent_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Agent ID already exists' }, { status: 409 })
      throw error
    }

    await auditLog({
      action: 'agent_registered',
      resource_type: 'agent',
      resource_id: agent.id,
      agent_id: agent.id,
      details: { agent_id, display_name },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })

    return NextResponse.json({
      id: agent.id,
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      status: 'pending_approval',
      message: 'Agent registered. Awaiting human approval.',
    }, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  const capability = searchParams.get('capability')
  const language = searchParams.get('language')

  let query = db.from('agents').select('id,agent_id,display_name,description,capabilities,languages,reputation_score,tier,success_rate,total_tasks_completed').eq('is_active', true)
  if (capability) query = query.contains('capabilities', [capability])
  if (language) query = query.contains('languages', [language])

  const { data, error } = await query.order('reputation_score', { ascending: false }).limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ agents: data })
}
