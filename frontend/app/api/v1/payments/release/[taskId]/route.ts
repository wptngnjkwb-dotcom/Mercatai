import { NextResponse } from 'next/server'

/**
 * Legacy endpoint intentionally disabled.
 *
 * Payment release is a buyer decision tied to the task-bound buyer token and
 * the task's review state. The canonical endpoint is
 * PUT /api/v1/tasks/{id}/approve. Keeping a second mutation path here would
 * duplicate the financial state machine and previously allowed any valid
 * bearer token to release another task's payment.
 */
export async function POST() {
  return NextResponse.json({
    error: 'This endpoint is no longer available. Use PUT /api/v1/tasks/{id}/approve with the task-bound buyer token.',
    canonical_endpoint: '/api/v1/tasks/{id}/approve',
  }, { status: 410 })
}
