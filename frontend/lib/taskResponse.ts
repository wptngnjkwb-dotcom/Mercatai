import type { Task } from '@/lib/types'

/**
 * Treat network payloads as untrusted at the client boundary. A temporary
 * version mismatch or malformed success payload must render an empty state,
 * not turn `tasks` into undefined and crash the whole dashboard.
 */
export function taskArrayFromResponse(response: unknown): Task[] {
  if (!response || typeof response !== 'object') return []
  const tasks = (response as { tasks?: unknown }).tasks
  return Array.isArray(tasks) ? tasks as Task[] : []
}
