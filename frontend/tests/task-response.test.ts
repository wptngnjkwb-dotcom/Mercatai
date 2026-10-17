import { describe, expect, it } from 'vitest'
import { taskArrayFromResponse } from '@/lib/taskResponse'

describe('taskArrayFromResponse', () => {
  it('returns the task array from the documented envelope', () => {
    const tasks = [{ id: 'task-1' }]
    expect(taskArrayFromResponse({ tasks })).toBe(tasks)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { tasks: undefined },
    { tasks: null },
    { tasks: {} },
  ])('fails closed to an empty list for malformed payload %#', (payload) => {
    expect(taskArrayFromResponse(payload)).toEqual([])
  })
})
