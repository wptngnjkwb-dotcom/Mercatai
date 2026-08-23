import { NextRequest, NextResponse } from 'next/server'
import { getSupabase } from '@/lib/server/supabase'
import { getTokenFromRequest } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { recordModerationEvent } from '@/lib/server/taskModeration/audit'

// Suspend or reinstate an organization. A suspended org is blocked from
// posting new tasks and from instant-hire (see POST /tasks and
// POST /store/[listingId]/hire) — existing tasks are untouched here; use
// the moderation queue to act on those individually.
export async function PUT(request: NextRequest, { params }: { params: { orgId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token || token.tier !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  if (typeof body.suspended !== 'boolean') {
    return NextResponse.json({ error: 'suspended (boolean) is required' }, { status: 400 })
  }

  const db = getSupabase()
  const { data, error } = await db
    .from('organizations')
    .update({ is_suspended: body.suspended })
    .eq('id', params.orgId)
    .select('id,name,is_suspended')
    .single()
  if (error || !data) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })

  await auditLog({
    action: body.suspended ? 'organization_suspended' : 'organization_reinstated',
    resource_type: 'organization',
    resource_id: params.orgId,
    details: { reason: body.reason },
  })

  // Anchor the event on the task the admin was reviewing, if given — the
  // trail is inherently task-scoped, but a suspension is usually decided
  // while looking at one specific task from that organization.
  if (body.suspended && typeof body.task_id === 'string') {
    await recordModerationEvent({
      taskId: body.task_id,
      eventType: 'organization_suspended',
      actorType: 'admin',
      actorId: 'admin',
      notes: `Organization "${data.name}" (${params.orgId}) suspended.${body.reason ? ` Reason: ${body.reason}` : ''}`,
    })
  }

  return NextResponse.json(data)
}
