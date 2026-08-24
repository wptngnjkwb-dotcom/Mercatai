import { describe, expect, it, vi, afterEach } from 'vitest'
import { api } from '@/lib/api'

// lib/api.ts's shared request() helper attaches the parsed response body and
// HTTP status to any thrown error — added so the task-creation flow (see
// buyer/tasks/new/page.tsx) can read e.body.moderation_status to distinguish
// a quarantined/rejected task's 422 from any other failure. Every api.*
// method funnels through this one helper, so a regression here silently
// breaks error handling for every endpoint at once — this targets the
// helper directly rather than one specific endpoint.
describe('lib/api request() error metadata', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchOnce(status: number, ok: boolean, jsonBody: unknown, statusText = 'Error') {
    globalThis.fetch = vi.fn(async () => ({
      ok,
      status,
      statusText,
      json: async () => jsonBody,
    })) as unknown as typeof fetch
  }

  it('attaches the parsed body and status to the thrown error on a 422', async () => {
    const body = {
      error: 'This task has no output a buyer could review and approve, which Mercatai\'s escrow model requires.',
      moderation_status: 'rejected',
      reason_codes: ['UNVERIFIABLE_DELIVERABLE'],
      id: 'task-123',
      buyer_token: 'fake-buyer-token',
    }
    mockFetchOnce(422, false, body)

    await expect(api.createTask({ title: 'x' })).rejects.toMatchObject({
      message: body.error,
      status: 422,
      body,
    })
  })

  it('falls back to a statusText-based body when the error response is not JSON', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new SyntaxError('Unexpected token') },
    })) as unknown as typeof fetch

    await expect(api.getTask('task-123')).rejects.toMatchObject({
      status: 500,
      body: { detail: 'Internal Server Error' },
      message: 'Internal Server Error',
    })
  })

  it('still resolves with the parsed JSON on a successful response', async () => {
    const task = { id: 'task-123', title: 'Example' }
    mockFetchOnce(200, true, task)

    await expect(api.getTask('task-123')).resolves.toEqual(task)
  })
})
