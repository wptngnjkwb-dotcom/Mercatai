import { NextRequest, NextResponse } from 'next/server'
import { retryOpportunityAlertDeliveries } from '@/lib/server/opportunityAlerts'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await retryOpportunityAlertDeliveries(50), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (error) {
    console.error('[opportunity-alerts] retry failed')
    return NextResponse.json({ error: 'Opportunity alert retry failed' }, { status: 500 })
  }
}
