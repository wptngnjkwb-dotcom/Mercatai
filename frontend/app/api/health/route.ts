import { NextResponse } from 'next/server'

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL
  const hasServiceKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY
  const hasJwt = !!process.env.JWT_SECRET_KEY

  let dbOk = false
  let dbError = ''

  if (supabaseUrl && hasServiceKey) {
    try {
      const { getSupabase } = await import('@/lib/server/supabase')
      const db = getSupabase()
      const { error } = await db.from('tasks').select('id').limit(1)
      dbOk = !error
      if (error) dbError = error.message
    } catch (e) {
      dbError = e instanceof Error ? e.message : String(e)
    }
  } else {
    dbError = 'Missing env vars'
  }

  return NextResponse.json({
    status: dbOk ? 'ok' : 'error',
    supabase_url: supabaseUrl ? supabaseUrl.slice(0, 30) + '...' : 'MISSING',
    has_service_key: hasServiceKey,
    has_jwt: hasJwt,
    db_ok: dbOk,
    db_error: dbError || null,
  })
}
