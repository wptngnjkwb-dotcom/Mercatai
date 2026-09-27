'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, MessageSquare, ShieldAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { api } from '@/lib/api'
import type { Task, QualityIssue } from '@/lib/types'

const REASON_KEYS: Record<string, string> = {
  not_as_described: 'reasonNotAsDescribed',
  incomplete_delivery: 'reasonIncomplete',
  quality_below_expectations: 'reasonBelowExpectations',
  other: 'reasonOther',
}

// Agent-facing status for a delivered task — mirrors the buyer's review
// screen (app/[locale]/(buyer)/buyer/tasks/[id]/bids/page.tsx) but only
// ever offers the ONE action that is genuinely the agent's own decision:
// voluntarily accepting a full refund on an open Quality Issue. It never
// shows a Mercatai-side "resolve" action, because there isn't one.
export default function AgentTaskReviewPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const t = useTranslations('qualityIssue')

  const [task, setTask] = useState<Task | null>(null)
  const [issues, setIssues] = useState<QualityIssue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => {
    Promise.all([api.getTask(taskId), api.getTaskIssues(taskId)])
      .then(([taskRes, issuesRes]) => {
        setTask(taskRes)
        setIssues(issuesRes.issues)
      })
      .catch((e) => setError(e instanceof Error ? e.message : t('errorFallback')))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (taskId) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const openIssue = issues.find((i) => i.status === 'open')
  const latestIssue = issues[0]

  const handleReply = async () => {
    if (!openIssue || !replyText.trim()) return
    setBusy(true)
    setError('')
    try {
      await api.postQualityIssueMessage(taskId, openIssue.id, replyText.trim())
      setReplyText('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errorFallback'))
    } finally {
      setBusy(false)
    }
  }

  const handleAcceptRefund = async () => {
    if (!openIssue) return
    if (!confirm(t('acceptRefundConfirm'))) return
    setBusy(true)
    setError('')
    try {
      await api.acceptQualityIssueRefund(taskId, openIssue.id)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errorFallback'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="max-w-2xl mx-auto px-4 py-10 text-gray-500">{t('loading')}</div>

  if (!task) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10">
        <p className="text-red-600 mb-4">{error || t('taskNotFound')}</p>
        <Link href="/agent/dashboard" className="text-brand-700 hover:underline">← {t('backToTask')}</Link>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Link href="/agent/dashboard" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6">
        <ArrowLeft size={14} /> {t('backToTask')}
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">{t('pageTitle')}</h1>
      <p className="text-gray-500 mb-6">{task.title}</p>

      {!openIssue && (
        <div className="card p-5">
          <p className="text-sm text-gray-600">{t('noIssueBody')}</p>
        </div>
      )}

      {openIssue && (
        <div className="card p-5 border border-amber-200 bg-amber-50 space-y-4">
          <div className="flex items-start gap-2">
            <ShieldAlert size={18} className="text-amber-700 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-900">{t('issueOpenTitle')}</p>
              <p className="text-sm text-amber-800">
                {t('issueReasonLabel')}: {t(REASON_KEYS[openIssue.reason_code] ?? 'reasonOther')}
              </p>
              <p className="text-sm text-amber-800">
                {t('issueDeadlineLabel')}: {new Date(openIssue.response_deadline_at).toLocaleString()}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto bg-white rounded-lg p-3 border border-amber-100">
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              <strong>{t('buyerLabel')}:</strong> {openIssue.initial_message}
            </p>
            {openIssue.messages.map((m) => (
              <p key={m.id} className="text-sm text-gray-700 whitespace-pre-wrap">
                <strong>{m.author_role === 'agent' ? t('youLabel') : t('buyerLabel')}:</strong> {m.message}
              </p>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              className="input flex-1"
              maxLength={5000}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t('replyPlaceholder')}
            />
            <button onClick={handleReply} disabled={busy || !replyText.trim()} className="btn-secondary disabled:opacity-50">
              <MessageSquare size={16} />
            </button>
          </div>

          <div className="border-t border-amber-200 pt-3">
            <button onClick={handleAcceptRefund} disabled={busy} className="btn-danger disabled:opacity-50">
              {t('acceptRefundButton')}
            </button>
            <p className="text-xs text-amber-700 mt-2">{t('acceptRefundNote')}</p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {!openIssue && latestIssue && latestIssue.status !== 'open' && (
        <div className="card p-5 mt-4">
          <p className="text-sm text-gray-600">
            {t('resolvedTitle')}: {t(
              latestIssue.status === 'agent_refunded' ? 'resolutionRefunded'
                : latestIssue.status === 'expired' ? 'resolutionExpired'
                : 'resolutionApproved'
            )}
          </p>
        </div>
      )}
    </div>
  )
}
