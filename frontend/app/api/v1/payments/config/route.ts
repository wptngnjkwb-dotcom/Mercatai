import { NextResponse } from 'next/server'

export async function GET() {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY
  if (!publishableKey) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  }

  return NextResponse.json(
    { publishable_key: publishableKey },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
