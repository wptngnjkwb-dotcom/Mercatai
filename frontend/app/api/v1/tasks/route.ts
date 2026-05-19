import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { auditLog } from '@/lib/server/audit'
import { signToken } from '@/lib/server/auth'
import { fireWebhooks } from '@/lib/server/webhooks'
import { resolveApiClient } from '@/lib/server/affiliate'

// Run in Supabase:
// ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

export async function GET(request: NextRequest) {
  try {
    const db = getSupabase()
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'open'
    const category = searchParams.get('category')
    const limit = Math.min(Number(searchParams.get('limit') || 20), 100)

    // Exclude embedding (vector field) from public response
    let query = db.from('tasks').select('id,title,description,category,status,budget_min_eur,budget_max_eur,deadline_hours,required_capabilities,required_languages,posted_by_org_id,assigned_agent_id,bidding_closes_at,created_at').eq('status', status)
    if (category) query = query.eq('category', category)

    const { data, error } = await query.order('created_at', { ascending: false }).limit(limit)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ tasks: data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// Simple in-memory rate limit: max 5 tasks per IP per hour
const ipTaskCount = new Map<string, { count: number; resetAt: number }>()

export async function POST(request: NextRequest) {
  try {
    // Rate limiting: 5 tasks per IP per hour
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const now = Date.now()
    const entry = ipTaskCount.get(ip)
    if (entry && now < entry.resetAt) {
      if (entry.count >= 5) {
        return NextResponse.json({ error: 'Rate limit exceeded — max 5 tasks per hour per IP' }, { status: 429 })
      }
      entry.count++
    } else {
      ipTaskCount.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 })
    }

    const body = await request.json()
    const {
      title, description, category, required_capabilities, required_languages,
      budget_min_eur, budget_max_eur, deadline_hours, org_name,
    } = body

    if (!title || !description || !budget_max_eur || !deadline_hours) {
      return NextResponse.json({ error: 'title, description, budget_max_eur and deadline_hours are required' }, { status: 400 })
    }
    if (typeof budget_max_eur !== 'number' || budget_max_eur < 1) {
      return NextResponse.json({ error: 'budget_max_eur must be at least €1' }, { status: 400 })
    }
    if (budget_max_eur > 10_000) {
      return NextResponse.json({ error: 'budget_max_eur cannot exceed €10,000 without KYC' }, { status: 400 })
    }
    if (typeof deadline_hours !== 'number' || deadline_hours < 1 || deadline_hours > 8760) {
      return NextResponse.json({ error: 'deadline_hours must be between 1 and 8760 (1 year)' }, { status: 400 })
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

    // Detect third-party API client for affiliate tracking
    const apiClient = await resolveApiClient(request.headers.get('authorization'))

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
        ...(apiClient ? { referred_by_client_id: apiClient.id } : {}),
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

    // Fire webhooks async — do not await
    fireWebhooks('task.created', { task_id: task.id, title, category: task.category, budget_max_eur })

    const buyerToken = await signToken(
      {
        role: 'buyer',
        task_id: task.id,
        org_id: orgId,
      },
      '30d'  // 30 days — long enough to cover task lifecycle
    )

    return NextResponse.json({
      ...task,
      buyer_token: buyerToken,
      buyer_token_note: 'Save this token — required to approve or dispute this task',
    }, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
