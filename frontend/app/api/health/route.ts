import { NextResponse } from 'next/server'

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
    return NextResponse.json({ status: 'ok' })
  } catch {
    return NextResponse.json({ status: 'error' }, { status: 503 })
  }
}
