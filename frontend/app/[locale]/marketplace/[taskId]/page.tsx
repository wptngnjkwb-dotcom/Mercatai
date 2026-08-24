'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, Clock, Euro, Users, Globe, Wrench, Flag } from 'lucide-react'
import { api } from '@/lib/api'
import type { Task, Bid } from '@/lib/types'

// Mirrors PUBLIC_EXPLANATIONS' keys in lib/server/taskModeration/policy.ts —
// short labels for a compact dropdown rather than that file's full sentences.
// Keep in sync if a reason code is ever added/renamed there.
const REPORT_REASONS: { value: string; label: string }[] = [
  { value: 'SPAM', label: 'Spam' },
  { value: 'PHISHING', label: 'Phishing' },
  { value: 'CREDENTIAL_HARVESTING', label: 'Asks for passwords / API keys' },
  { value: 'WALLET_OR_TRANSACTION_REQUEST', label: 'Asks to connect a wallet / sign a transaction' },
  { value: 'OFF_PLATFORM_PAYMENT', label: 'Payment outside Mercatai' },
  { value: 'AFFILIATE_RECRUITMENT', label: 'External affiliate / referral scheme' },
  { value: 'EXTERNAL_ACCOUNT_CREATION', label: 'Asks to create an external account' },
  { value: 'MALWARE_OR_UNSAFE_DOWNLOAD', label: 'Malware / unsafe download' },
  { value: 'TERRORIST_SUPPORT', label: 'Terrorist support' },
  { value: 'VIOLENT_EXTREMISM', label: 'Violent extremism' },
  { value: 'HATE_OR_RELIGIOUS_HARASSMENT', label: 'Hate or religious harassment' },
  { value: 'POLITICAL_OR_RELIGIOUS_RECRUITMENT', label: 'Political / religious recruitment' },
  { value: 'FOREIGN_INFORMATION_MANIPULATION', label: 'Coordinated disinformation' },
  { value: 'SANCTIONS_EVASION', label: 'Sanctions evasion' },
  { value: 'PRIVACY_VIOLATION', label: 'Privacy violation' },
  { value: 'ILLEGAL_SERVICE', label: 'Illegal service' },
  { value: 'PROMPT_INJECTION', label: 'Prompt injection targeting agents' },
  { value: 'UNVERIFIABLE_DELIVERABLE', label: 'No reviewable deliverable' },
  { value: 'SUSPICIOUS_EXTERNAL_LINK', label: 'Suspicious external link' },
]

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  bidding: 'bg-blue-100 text-blue-800',
  assigned: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-orange-100 text-orange-800',
  review: 'bg-purple-100 text-purple-800',
  completed: 'bg-gray-100 text-gray-600',
  disputed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-400',
}

const CATEGORY_LABELS: Record<string, string> = {
  research: 'Research',
  content: 'Content',
  code_review: 'Code Review',
  procurement: 'Procurement',
  data_analysis: 'Data Analysis',
  translation: 'Translation',
  finance: 'Finance & ERP',
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return atob(padded)
}

// UI-gating only — the /report endpoint itself always re-verifies the token
// server-side regardless of what this returns. This just keeps the button
// from flashing/staying visible for a signed-out visitor, a stale/expired
// token, or a token that isn't structurally an agent session at all
// (access_token is only ever an agent session in this codebase).
function hasValidAgentSession(): boolean {
  if (typeof window === 'undefined') return false
  const token = localStorage.getItem('access_token')
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    if (typeof payload.agent_id !== 'string' || !payload.agent_id) return false
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return false
    return true
  } catch {
    return false
  }
}

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>()

  const [task, setTask] = useState<Task | null>(null)
  const [bids, setBids] = useState<Bid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [loggedIn, setLoggedIn] = useState(false)
  const [showReportForm, setShowReportForm] = useState(false)
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0].value)
  const [reportDetails, setReportDetails] = useState('')
  const [reportSubmitting, setReportSubmitting] = useState(false)
  const [reportSubmitted, setReportSubmitted] = useState(false)
  const [reportAutoQuarantined, setReportAutoQuarantined] = useState(false)
  const [reportError, setReportError] = useState('')

  useEffect(() => {
    setLoggedIn(hasValidAgentSession())
  }, [])

  useEffect(() => {
    if (!taskId) return
    setLoading(true)
    Promise.all([api.getTask(taskId), api.getTaskBids(taskId).catch(() => ({ bids: [] }))])
      .then(([t, b]) => {
        setTask(t)
        setBids(b.bids ?? [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [taskId])

  const handleReport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!taskId) return
    setReportSubmitting(true)
    setReportError('')
    try {
      const res = await api.reportTask(taskId, reportReason, reportDetails.trim() || undefined)
      setReportAutoQuarantined(res.auto_quarantined)
      setReportSubmitted(true)
    } catch (err: any) {
      setReportError(err.status === 409 ? 'You have already reported this task.' : err.message)
    } finally {
      setReportSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading task…</div>

  if (error || !task) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="text-red-600 mb-4">{error || 'Task not found'}</p>
        <Link href="/marketplace" className="text-brand-700 hover:underline">← Back to marketplace</Link>
      </div>
    )
  }

  const isOpen = task.status === 'open' || task.status === 'bidding'

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/marketplace" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6">
        <ArrowLeft size={14} /> Back to marketplace
      </Link>

      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="badge bg-gray-100 text-gray-600 text-xs">
            {CATEGORY_LABELS[task.category] ?? task.category}
          </span>
          <span className={`badge ${STATUS_COLORS[task.status] ?? 'bg-gray-100 text-gray-600'}`}>
            {task.status.replace('_', ' ')}
          </span>
        </div>
        {loggedIn && !reportSubmitted && (
          <button
            type="button"
            onClick={() => setShowReportForm((v) => !v)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-600 transition-colors"
          >
            <Flag size={12} /> Report
          </button>
        )}
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-4">{task.title}</h1>

      {(showReportForm || reportSubmitted) && (
        <div className="card p-4 mb-4 bg-red-50 border-red-200">
          {reportSubmitted ? (
            <p className="text-sm text-green-700">
              {reportAutoQuarantined
                ? 'Thanks — this task has been pulled from public view pending review.'
                : 'Thanks, your report has been received.'}
            </p>
          ) : (
            <form onSubmit={handleReport} className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-700">Why are you reporting this task?</label>
              <select className="input text-sm" value={reportReason} onChange={(e) => setReportReason(e.target.value)}>
                {REPORT_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <textarea
                className="input text-sm min-h-16 resize-y"
                maxLength={1000}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                placeholder="Additional details (optional)"
              />
              {reportError && <p className="text-xs text-red-600">{reportError}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={reportSubmitting} className="btn-secondary py-1.5 text-sm disabled:opacity-50">
                  {reportSubmitting ? 'Submitting…' : 'Submit report'}
                </button>
                <button type="button" onClick={() => setShowReportForm(false)} className="text-sm text-gray-400 hover:text-gray-600">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <div className="card p-5 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Euro size={12} /> Budget</div>
            <div className="font-semibold text-gray-900">€{task.budget_min_eur}–{task.budget_max_eur}</div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Clock size={12} /> Deadline</div>
            <div className="font-semibold text-gray-900">{task.deadline_hours}h</div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Users size={12} /> Bids</div>
            <div className="font-semibold text-gray-900">{task.bid_count ?? bids.length}</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs mb-1">Posted</div>
            <div className="font-semibold text-gray-900">{new Date(task.created_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>

      <section className="mb-6">
        <h2 className="font-semibold text-gray-900 mb-2">Brief</h2>
        <p className="text-gray-600 whitespace-pre-wrap">{task.description}</p>
      </section>

      {task.required_capabilities.length > 0 && (
        <section className="mb-4">
          <h2 className="flex items-center gap-1 font-semibold text-gray-900 mb-2">
            <Wrench size={14} /> Required capabilities
          </h2>
          <div className="flex flex-wrap gap-1">
            {task.required_capabilities.map((c) => (
              <span key={c} className="badge bg-brand-50 text-brand-700">{c}</span>
            ))}
          </div>
        </section>
      )}

      {task.required_languages.length > 0 && (
        <section className="mb-6">
          <h2 className="flex items-center gap-1 font-semibold text-gray-900 mb-2">
            <Globe size={14} /> Languages
          </h2>
          <div className="flex flex-wrap gap-1">
            {task.required_languages.map((l) => (
              <span key={l} className="badge bg-gray-100 text-gray-600">{l}</span>
            ))}
          </div>
        </section>
      )}

      {isOpen && (
        <div className="card p-5 flex flex-wrap items-center justify-between gap-3 bg-brand-50 border-brand-100">
          <div>
            <p className="font-semibold text-gray-900">Can your agent do this?</p>
            <p className="text-sm text-gray-500">Submit a price and delivery time — the buyer picks a bid.</p>
          </div>
          <Link href={`/agent/bid/${task.id}`} className="btn-primary">Place a bid</Link>
        </div>
      )}

      {bids.length > 0 && (
        <section className="mt-8">
          <h2 className="font-semibold text-gray-900 mb-3">Bids ({bids.length})</h2>
          <div className="flex flex-col gap-2">
            {bids.map((b) => (
              <div key={b.id} className="card p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate">{b.agent_display_name ?? 'Agent'}</p>
                  <p className="text-sm text-gray-500 line-clamp-2">{b.approach_summary}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-gray-900">€{b.price_eur}</div>
                  <div className="text-xs text-gray-400">{b.delivery_hours}h</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
