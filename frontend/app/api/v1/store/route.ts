import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { moderateTask } from '@/lib/server/taskModeration/moderateTask'
import { getLiveAgentPaymentSetup, paymentSetupRequiredBody, PaymentSetupLookupError } from '@/lib/server/agentPaymentSetup'
import { STANDARD_AGENT_LIABILITY } from '@/lib/server/stripeAccountRequirement'
import { parseStoreCatalogFilters, queryPublicStoreListings, STORE_CATEGORIES } from '@/lib/server/storeCatalog'

export const dynamic = 'force-dynamic'

// Public catalog of productized agent services.
export async function GET(request: NextRequest) {
  const db = getSupabase()
  const { searchParams } = new URL(request.url)
  let filters
  try {
    filters = parseStoreCatalogFilters(searchParams)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid filters' }, { status: 400 })
  }

  // A private agent's listings are excluded by the shared query, including
  // when a caller tries to address that agent directly through agent_id.
  const { data, error } = await queryPublicStoreListings(db, filters)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ listings: data ?? [], filters }, { headers: { 'Cache-Control': 'no-store' } })
}

// Create a listing — the agent offering the service, identified by its token.
export async function POST(request: NextRequest) {
  const token = await getTokenFromRequest(request)
  const agentId = typeof token?.agent_id === 'string' ? token.agent_id : null
  if (!agentId) return NextResponse.json({ error: 'Authenticate as an agent to create a listing' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const category = typeof body.category === 'string' ? body.category.trim() : 'research'
  const price_eur = body.price_eur
  const delivery_hours = body.delivery_hours ?? 24

  if (title.length < 5 || title.length > 120) {
    return NextResponse.json({ error: 'title must be between 5 and 120 characters' }, { status: 400 })
  }
  if (description.length < 20 || description.length > 5000) {
    return NextResponse.json({ error: 'description must be between 20 and 5,000 characters' }, { status: 400 })
  }
  if (!STORE_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: 'category is not supported' }, { status: 400 })
  }
  if (typeof price_eur !== 'number' || !Number.isFinite(price_eur) || price_eur < 1 || price_eur > 10_000) {
    return NextResponse.json({ error: 'price_eur must be between 1 and 10000' }, { status: 400 })
  }
  if (Math.abs(price_eur * 100 - Math.round(price_eur * 100)) > 1e-8) {
    return NextResponse.json({ error: 'price_eur may have at most two decimal places' }, { status: 400 })
  }
  if (!Number.isInteger(delivery_hours) || delivery_hours < 1 || delivery_hours > 720) {
    return NextResponse.json({ error: 'delivery_hours must be an integer between 1 and 720' }, { status: 400 })
  }

  const db = getSupabase()

  // A private agent isn't discoverable at all, so a Store listing it
  // created could never actually be found — reject the creation outright
  // rather than silently accepting one that would never appear anywhere.
  const { data: creatingAgent, error: agentError } = await db
    .from('agents')
    .select('id,profile_visibility,is_active,stripe_standard_account_id,stripe_standard_onboarding_completed')
    .eq('id', agentId)
    .single()
  if (agentError || !creatingAgent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  if (!creatingAgent.is_active) {
    return NextResponse.json({ error: 'Inactive agent cannot create a Store listing' }, { status: 403 })
  }
  if (creatingAgent.profile_visibility !== 'public') {
    return NextResponse.json({ error: 'A private agent cannot create a public Store listing. Switch your profile to public first.' }, { status: 403 })
  }

  // An active listing is a standing offer which a buyer can accept without
  // another agent confirmation. Publishing it is therefore a payment-state
  // boundary, not just profile editing: verify Standard readiness live before
  // the listing can appear in the catalog.
  try {
    const setup = await getLiveAgentPaymentSetup({
      db,
      agent: creatingAgent,
      requirement: STANDARD_AGENT_LIABILITY,
    })
    if (!setup.ready) {
      return NextResponse.json(paymentSetupRequiredBody(setup, true), { status: 402 })
    }
  } catch (error) {
    if (error instanceof PaymentSetupLookupError) {
      return NextResponse.json({ error: 'Payment setup could not be verified right now', code: 'payment_setup_unavailable' }, { status: 503 })
    }
    throw error
  }

  const moderation = await moderateTask({
    title,
    description,
    budgetMinEur: price_eur,
    budgetMaxEur: price_eur,
    category,
  })
  if (moderation.decision !== 'allow' && moderation.decision !== 'allow_with_warning') {
    await auditLog({
      action: 'listing_publication_blocked',
      resource_type: 'agent_listing',
      agent_id: agentId,
      details: { decision: moderation.decision, reason_codes: moderation.reasonCodes, risk_score: moderation.riskScore },
      ip_address: request.headers.get('x-forwarded-for') ?? undefined,
    })
    return NextResponse.json({
      error: 'This service cannot be published right now',
      reason_codes: moderation.reasonCodes,
      explanation: moderation.publicExplanation,
      policy_url: 'https://mercatai.eu/safety',
    }, { status: moderation.decision === 'quarantine' ? 202 : 422 })
  }

  // Keep the catalog manageable: max 5 active listings per agent
  const { count } = await db
    .from('agent_listings')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('status', 'active')
  if ((count ?? 0) >= 5) {
    return NextResponse.json({ error: 'Maximum of 5 active listings per agent' }, { status: 400 })
  }

  const { data, error } = await db
    .from('agent_listings')
    .insert({
      agent_id: agentId,
      title,
      description,
      category,
      price_eur,
      delivery_hours,
      is_active: true,
      status: 'active',
      moderation_status: 'approved',
      moderation_risk_score: moderation.riskScore,
      moderation_reason_codes: moderation.reasonCodes,
      moderation_policy_version: moderation.policyVersion,
      moderated_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({
    action: 'listing_created', resource_type: 'listing', resource_id: data.id,
    agent_id: agentId,
    details: { title, price_eur, status: 'active', moderation_status: 'approved' },
  })
  return NextResponse.json(data, { status: 201 })
}
