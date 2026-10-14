import { describe, expect, it } from 'vitest'
import { canViewTask } from '@/lib/server/taskVisibility'

const privateTask = {
  id: 'task-private',
  visibility: 'private',
  posted_by_org_id: 'org-buyer',
  assigned_agent_id: 'agent-target',
  target_agent_id: 'agent-target',
}

describe('private task visibility', () => {
  it('is visible only to its buyer, target/assigned agent, or admin', () => {
    expect(canViewTask({ role: 'buyer', task_id: 'task-private', org_id: 'org-buyer' }, privateTask)).toBe(true)
    expect(canViewTask({ role: 'agent', agent_id: 'agent-target' }, privateTask)).toBe(true)
    expect(canViewTask({ tier: 'admin' }, privateTask)).toBe(true)
    expect(canViewTask({ role: 'agent', agent_id: 'agent-other' }, privateTask)).toBe(false)
    expect(canViewTask({ role: 'buyer', task_id: 'task-other', org_id: 'org-buyer' }, privateTask)).toBe(false)
    expect(canViewTask(null, privateTask)).toBe(false)
  })

  it('keeps public tasks public and fails closed on unknown visibility values', () => {
    expect(canViewTask(null, { ...privateTask, visibility: 'public' })).toBe(true)
    expect(canViewTask(null, { ...privateTask, visibility: null })).toBe(true)
    expect(canViewTask({ tier: 'admin' }, { ...privateTask, visibility: 'future_mode' })).toBe(false)
  })
})
