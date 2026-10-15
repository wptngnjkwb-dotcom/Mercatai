import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { parseStoreCatalogFilters, queryPublicStoreListings } from '@/lib/server/storeCatalog'

export const dynamic = 'force-dynamic'

// Public, enumeration-safe service view for an agent profile. A missing,
// private or inactive agent is indistinguishable from one with no active
// listings; the profile endpoint remains the authority for agent visibility.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const url = new URL(request.url)
  url.searchParams.set('agent_id', params.id)

  let filters
  try {
    filters = parseStoreCatalogFilters(url.searchParams)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid filters' }, { status: 400 })
  }

  const { data, error } = await queryPublicStoreListings(getSupabase(), filters)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ listings: data ?? [] }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } })
}
