import { NextResponse } from 'next/server'

// A health check must always execute a fresh database round-trip. Without
// these route-level directives Vercel may cache a previous 200 response and
// hide a later database outage from external uptime monitors.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
}

// Public, unauthenticated endpoint for external uptime monitoring — see
// docs/self-hosting.md §7. Deliberately minimal: no database error text,
// connection details, or secret-presence flags, since anyone can request
// this with no credentials. A monitor should only need the HTTP status.
export async function GET() {
  try {
    const { getSupabase } = await import('@/lib/server/supabase')
    const db = getSupabase()
    const { error } = await db.from('tasks').select('id').limit(1)
    if (error) throw error
    return NextResponse.json({ status: 'ok' }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json(
      { status: 'error' },
      { status: 503, headers: NO_STORE_HEADERS },
    )
  }
}
