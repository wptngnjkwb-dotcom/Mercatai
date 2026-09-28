import { NextRequest, NextResponse } from 'next/server'
import { getTokenFromRequest } from '@/lib/server/auth'

// Retired together with the buyer-dispute/admin-resolution model. Mercatai
// does not decide whether buyer or agent should receive the task price.
// Objective missed-SLA refunds run through the cron; a Quality Issue can
// be refunded only by the assigned agent's explicit voluntary action.
export async function POST(request: NextRequest, { params }: { params: { taskId: string } }) {
  const token = await getTokenFromRequest(request)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({
    error: 'This endpoint is no longer available. Mercatai does not decide marketplace refunds. Use the Quality Issue flow; only the assigned agent may voluntarily accept a full refund, while objective missed-SLA refunds remain automatic.',
    task_id: params.taskId,
  }, { status: 410 })
}
