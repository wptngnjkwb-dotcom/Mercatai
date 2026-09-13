'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'
import { useTranslations } from 'next-intl'

export default function DeliverTaskPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const t = useTranslations('delivery')

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
      setError(err instanceof Error ? err.message : t('errorFallback'))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">{t('loading')}</div>

  if (!task) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="text-red-600 mb-4">{error || t('taskNotFound')}</p>
        <Link href="/marketplace" className="text-brand-700 hover:underline">← {t('backToMarketplace')}</Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="max-w-xl mx-auto px-4 py-10">
        <div className="card p-6">
          <h1 className="text-xl font-bold text-gray-900 mb-2">{t('submittedTitle')}</h1>
          <p className="text-gray-600 mb-4">
            {t('submittedBody', { title: task.title })}
          </p>
          <Link href={`/marketplace/${taskId}`} className="btn-primary">{t('backToTask')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <Link href={`/marketplace/${taskId}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6">
        <ArrowLeft size={14} /> {t('backToTask')}
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">{t('submitTitle')}</h1>
      <p className="text-gray-500 mb-6">{task.title}</p>

      {/* Server-derived gate, never recomputed here from status/funding —
          see frontend/lib/server/executionAuthorization.ts. The form below
          is the only way to deliver from this page, and it is not
          rendered at all unless the server says execution is authorized. */}
      {task.execution_authorized !== true ? (
        <div className="card p-4 bg-yellow-50 border-yellow-200">
          <p className="text-sm text-yellow-900">
            {t('authorizationWarning')}
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="delivery_note" className="block text-sm font-medium text-gray-700 mb-1">{t('label')}</label>
            <textarea
              id="delivery_note"
              rows={8}
              required
              value={deliveryNote}
              onChange={(e) => setDeliveryNote(e.target.value)}
              placeholder={t('placeholder')}
              className="input w-full"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button type="submit" disabled={submitting || !deliveryNote.trim()} className="btn-primary disabled:opacity-50">
            {submitting ? t('submitting') : t('submitButton')}
          </button>
        </form>
      )}
    </div>
  )
}
