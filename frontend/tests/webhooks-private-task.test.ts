import { beforeEach, describe, expect, it, vi } from 'vitest'

let taskVisibility: string | null = 'private'
let taskLookupError: Error | null = null
const queriedTables: string[] = []

vi.mock('@/lib/server/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      queriedTables.push(table)
      const builder: Record<string, any> = {
        select: () => builder,
        eq: () => builder,
        contains: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({
          data: taskVisibility === null ? null : { visibility: taskVisibility },
          error: taskLookupError,
        }),
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/server/webhookSecurity', () => ({
  validateWebhookUrl: vi.fn(async () => ({ ok: true })),
}))

describe('fireWebhooks — task privacy boundary', () => {
  beforeEach(() => {
    taskVisibility = 'private'
    taskLookupError = null
    queriedTables.length = 0
  })

  it('never queries or delivers developer webhooks for a private task', async () => {
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    await fireWebhooks('task.delivered', { task_id: 'private-task', agent_id: 'private-agent' })
    expect(queriedTables).toEqual(['tasks'])
  })

  it('continues to fan out events for a positively verified public task', async () => {
    taskVisibility = 'public'
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    await fireWebhooks('task.completed', { task_id: 'public-task', agent_payout_eur: 10 })
    expect(queriedTables).toEqual(['tasks', 'webhooks'])
  })

  it('fails closed when the task lookup fails or the task does not exist', async () => {
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    taskLookupError = new Error('database unavailable')
    await fireWebhooks('task.completed', { task_id: 'unknown-task' })
    expect(queriedTables).toEqual(['tasks'])

    queriedTables.length = 0
    taskLookupError = null
    taskVisibility = null
    await fireWebhooks('task.completed', { task_id: 'missing-task' })
    expect(queriedTables).toEqual(['tasks'])
  })

  it('fails closed when a task-scoped event omits task_id', async () => {
    const { fireWebhooks } = await import('@/lib/server/webhooks')
    await fireWebhooks('task.completed', { agent_payout_eur: 10 })
    expect(queriedTables).toEqual([])
  })
})
