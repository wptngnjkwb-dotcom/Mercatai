import crypto from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyAgentWebhook } from '@/lib/server/agentNotifications'

const { validateWebhookUrl } = vi.hoisted(() => ({
  validateWebhookUrl: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(
    async () => ({ ok: true }),
  ),
}))
vi.mock('@/lib/server/webhookSecurity', () => ({ validateWebhookUrl }))

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))

function dbWithAgent(agent: { webhook_url: string | null; webhook_secret: string | null } | null) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: agent, error: null }),
  }
  return { from: () => builder } as any
}

describe('private agent Quality Issue webhooks', () => {
  beforeEach(() => {
    fetchMock.mockClear()
    validateWebhookUrl.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('sends a signed event only to the assigned agent webhook without private message text', async () => {
    await notifyAgentWebhook(
      dbWithAgent({ webhook_url: 'https://agent.example/hook', webhook_secret: 'secret-1' }),
      'agent-1',
      'quality_issue.opened',
      { task_id: 'task-1', quality_issue_id: 'issue-1' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://agent.example/hook')
    const body = String(init.body)
    expect(body).toContain('quality_issue.opened')
    expect(body).toContain('issue-1')
    expect(body).not.toMatch(/message|buyer_email|owner_email/i)
    const expected = `sha256=${crypto.createHmac('sha256', 'secret-1').update(body).digest('hex')}`
    expect((init.headers as Record<string, string>)['X-Mercatai-Signature']).toBe(expected)
  })

  it('does not call an unsafe or unconfigured URL', async () => {
    validateWebhookUrl.mockResolvedValueOnce({ ok: false as const, error: 'private address' })
    await notifyAgentWebhook(
      dbWithAgent({ webhook_url: 'https://127.0.0.1/hook', webhook_secret: 'secret-1' }),
      'agent-1',
      'quality_issue.message',
      { task_id: 'task-1', quality_issue_id: 'issue-1' },
    )
    await notifyAgentWebhook(dbWithAgent(null), 'agent-1', 'quality_issue.message', {
      task_id: 'task-1', quality_issue_id: 'issue-1',
    })
    await notifyAgentWebhook(
      dbWithAgent({ webhook_url: 'https://agent.example/hook', webhook_secret: null }),
      'agent-1',
      'quality_issue.message',
      { task_id: 'task-1', quality_issue_id: 'issue-1' },
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
