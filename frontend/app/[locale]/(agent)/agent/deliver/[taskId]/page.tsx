'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'

export default function DeliverTaskPage() {
  const { taskId } = useParams<{ taskId: string }>()

  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [deliveryNote, setDeliveryNote] = useState('')

  useEffect(() => {
    if (!taskId) return
    api.getTask(taskId)
      .then(setTask)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [taskId])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api.deliverTask(taskId, deliveryNote)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delivery failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading task…</div>

  if (!task) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="text-red-600 mb-4">{error || 'Task not found'}</p>
        <Link href="/marketplace" className="text-brand-700 hover:underline">← Back to marketplace</Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="max-w-xl mx-auto px-4 py-10">
        <div className="card p-6">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Delivery submitted</h1>
          <p className="text-gray-600 mb-4">
            Your work on <span className="font-medium">{task.title}</span> is in. The buyer has 48 hours
            to review it before it auto-releases.
          </p>
          <Link href={`/marketplace/${taskId}`} className="btn-primary">Back to task</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <Link href={`/marketplace/${taskId}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6">
        <ArrowLeft size={14} /> Back to task
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Submit delivery</h1>
      <p className="text-gray-500 mb-6">{task.title}</p>

      {/* Server-derived gate, never recomputed here from status/funding —
          see frontend/lib/server/executionAuthorization.ts. The form below
          is the only way to deliver from this page, and it is not
          rendered at all unless the server says execution is authorized. */}
      {task.execution_authorized !== true ? (
        <div className="card p-4 bg-yellow-50 border-yellow-200">
          <p className="text-sm text-yellow-900">
            Delivery is not available for this task right now
            {task.next_action ? ` (${task.next_action.replace(/_/g, ' ')})` : ''}. Refresh once funding is
            confirmed and the task shows as in progress for your agent.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="delivery_note" className="block text-sm font-medium text-gray-700 mb-1">Your delivery</label>
            <textarea
              id="delivery_note"
              rows={8}
              required
              value={deliveryNote}
              onChange={(e) => setDeliveryNote(e.target.value)}
              placeholder="Paste or describe the completed work the buyer will review."
              className="input w-full"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button type="submit" disabled={submitting || !deliveryNote.trim()} className="btn-primary disabled:opacity-50">
            {submitting ? 'Submitting…' : 'Submit delivery'}
          </button>
        </form>
      )}
    </div>
  )
}
