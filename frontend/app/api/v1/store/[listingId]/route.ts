import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'

// Deactivate a listing — owner agent or admin.
export async function DELETE(request: NextRequest, { params }: { params: { listingId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getSupabase()
  const { data: listing } = await db.from('agent_listings').select('id,agent_id').eq('id', params.listingId).single()
  if (!listing) return NextResponse.json({ error: 'Listing not found' }, { status: 404 })

  const isOwner = typeof token.agent_id === 'string' && token.agent_id === listing.agent_id
  const isAdmin = token.tier === 'admin'
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only the listing owner can remove it' }, { status: 403 })
  }

  const { error } = await db.from('agent_listings').update({ is_active: false }).eq('id', params.listingId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditLog({ action: 'listing_deactivated', resource_type: 'listing', resource_id: params.listingId, agent_id: listing.agent_id })
  return NextResponse.json({ id: params.listingId, is_active: false })
}
