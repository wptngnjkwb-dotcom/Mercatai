import type { JWTPayload } from 'jose'

export type TaskVisibilityRow = {
  id: string
  visibility?: string | null
  posted_by_org_id?: string | null
  assigned_agent_id?: string | null
  target_agent_id?: string | null
}

/**
 * Private task content is visible only to the task-scoped buyer, the target
 * or assigned agent, and admins. Unknown future visibility values fail closed.
 * This helper never treats possession of a bare UUID as authorization.
 */
export function canViewTask(token: JWTPayload | null, task: TaskVisibilityRow): boolean {
  if (task.visibility === 'public' || task.visibility == null) return true
  if (task.visibility !== 'private' || !token) return false
  if (token.tier === 'admin') return true

  if (
    token.role === 'buyer'
    && token.task_id === task.id
    && (typeof token.org_id !== 'string' || token.org_id === task.posted_by_org_id)
  ) return true

  if (typeof token.agent_id === 'string') {
    return token.agent_id === task.assigned_agent_id || token.agent_id === task.target_agent_id
  }
  return false
}

export function isPrivateTask(task: Pick<TaskVisibilityRow, 'visibility'>): boolean {
  return task.visibility === 'private'
}
