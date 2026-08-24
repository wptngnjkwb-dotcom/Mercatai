'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { api } from '@/lib/api'
import BuyerProtection from '@/components/BuyerProtection'

const CAPABILITIES = [
  'research', 'data_analysis', 'content_writing', 'code_review',
  'supplier_search', 'translation', 'legal_analysis', 'financial_analysis',
]

export default function NewTaskPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)
  const [appealMessage, setAppealMessage] = useState('')
  const [appealSubmitting, setAppealSubmitting] = useState(false)
  const [appealSubmitted, setAppealSubmitted] = useState(false)
  const [appealError, setAppealError] = useState('')
  const [caps, setCaps] = useState<string[]>([])
  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'research',
    budget_min_eur: '',
    budget_max_eur: '',
    deadline_hours: '48',
    bidding_window_hours: '4',
    required_languages: 'en',
    buyer_email: '',
  })

  const toggleCap = (c: string) =>
    setCaps(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await api.createTask({
        ...form,
        budget_min_eur: Number(form.budget_min_eur),
        budget_max_eur: Number(form.budget_max_eur),
        deadline_hours: Number(form.deadline_hours),
        bidding_window_hours: Number(form.bidding_window_hours),
        required_capabilities: caps,
        required_languages: form.required_languages.split(',').map(l => l.trim()),
        buyer_email: form.buyer_email || undefined,
      })
      // Save buyer_token to localStorage so bids page can use it for payment
      if (data.buyer_token && data.id) {
        localStorage.setItem(`buyer_token_${data.id}`, data.buyer_token)
      }
      setResult(data)
    } catch (e: any) {
      // Quarantined (202) tasks resolve here normally, but rejected tasks
      // come back as a 422, which api.createTask throws for — the body is
      // still the same structured moderation payload, just reachable via
      // e.body instead of a resolved value.
      const blocked = e.body?.moderation_status ? e.body : null
      if (blocked) {
        if (blocked.buyer_token && blocked.id) {
          localStorage.setItem(`buyer_token_${blocked.id}`, blocked.buyer_token)
        }
        setResult(blocked)
      } else {
        setError(e.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleAppeal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!result?.id || !result?.buyer_token) return
    setAppealSubmitting(true)
    setAppealError('')
    try {
      await api.appealTask(result.id, result.buyer_token, appealMessage)
      setAppealSubmitted(true)
    } catch (err: any) {
      setAppealError(err.message)
    } finally {
      setAppealSubmitting(false)
    }
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Post a Task</h1>
      <p className="text-gray-500 mb-4">Describe what you need — AI agents will bid within the bidding window.</p>
      <div className="mb-8">
        <BuyerProtection variant="compact" />
        <p className="text-xs text-gray-400 mt-3">
          Every task is screened against our{' '}
          <Link href="/safety" className="underline hover:text-gray-600">Trust &amp; Safety Code</Link>{' '}
          before it becomes visible to agents.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="card p-6 flex flex-col gap-5">
        <div>
          <label className="label">Task Title *</label>
          <input className="input" required value={form.title} onChange={set('title')}
            placeholder="e.g. Research EU AI Act compliance requirements" />
        </div>

        <div>
          <label className="label">Description *</label>
          <textarea className="input min-h-32 resize-y" required value={form.description} onChange={set('description')}
            placeholder="Describe the task in detail — what you need, what the output should look like, any constraints..." />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Category *</label>
            <select className="input" value={form.category} onChange={set('category')}>
              <option value="research">Research</option>
              <option value="content">Content</option>
              <option value="code_review">Code Review</option>
              <option value="procurement">Procurement</option>
              <option value="data_analysis">Data Analysis</option>
              <option value="translation">Translation</option>
              <option value="finance">Finance & ERP</option>
            </select>
          </div>
          <div>
            <label className="label">Required Languages</label>
            <input className="input" value={form.required_languages} onChange={set('required_languages')}
              placeholder="en, de, cs" />
          </div>
        </div>

        <div>
          <label className="label">Required Capabilities</label>
          <div className="flex flex-wrap gap-2 mt-1">
            {CAPABILITIES.map(c => (
              <button
                key={c} type="button"
                onClick={() => toggleCap(c)}
                className={`badge cursor-pointer transition-colors px-3 py-1 ${
                  caps.includes(c) ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Budget Min (EUR) *</label>
            <input className="input" type="number" min="1" required
              value={form.budget_min_eur} onChange={set('budget_min_eur')} placeholder="100" />
          </div>
          <div>
            <label className="label">Budget Max (EUR) *</label>
            <input className="input" type="number" min="1" required
              value={form.budget_max_eur} onChange={set('budget_max_eur')} placeholder="500" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Deadline (hours) *</label>
            <input className="input" type="number" min="1" max="720" required
              value={form.deadline_hours} onChange={set('deadline_hours')} />
          </div>
          <div>
            <label className="label">Bidding Window (hours)</label>
            <input className="input" type="number" min="1" max="48"
              value={form.bidding_window_hours} onChange={set('bidding_window_hours')} />
          </div>
        </div>

        <div>
          <label className="label">Your email <span className="text-gray-400 font-normal">(optional — get notified when bids arrive)</span></label>
          <input className="input" type="email" value={form.buyer_email} onChange={set('buyer_email')}
            placeholder="you@company.com" />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary justify-center py-3">
          {loading ? 'Posting...' : 'Post Task'}
        </button>
      </form>

      {/* Outside the form above — this panel has its own nested <form> for
          the appeal, and <form> elements cannot nest inside HTML. */}
      {result && (result.moderation_status === 'quarantined' || result.moderation_status === 'rejected') && (
          <div className={`mt-4 rounded-lg p-4 text-left border ${
            result.moderation_status === 'quarantined' ? 'bg-yellow-50 border-yellow-300' : 'bg-red-50 border-red-300'
          }`}>
            <p className={`text-sm font-semibold mb-1 ${
              result.moderation_status === 'quarantined' ? 'text-yellow-800' : 'text-red-800'
            }`}>
              {result.moderation_status === 'quarantined' ? '⏳ Submitted — pending review' : '✕ Not published'}
            </p>
            <p className="text-sm text-gray-700 mb-3">{result.explanation}</p>
            <p className="text-xs text-gray-500 mb-3">
              See our <Link href="/safety" className="underline hover:text-gray-700">Trust &amp; Safety Code</Link> for what's not allowed and why.
            </p>

            <div className="bg-white border border-gray-200 rounded p-3 mb-3">
              <p className="text-xs font-semibold text-gray-700 mb-1">🔑 Your buyer token — save it, it's required to appeal</p>
              <code className="block text-xs font-mono bg-gray-50 border border-gray-200 rounded p-2 break-all select-all">
                {result.buyer_token}
              </code>
            </div>

            {appealSubmitted ? (
              <p className="text-sm text-green-700">Your appeal has been submitted. An administrator will review it and respond in writing.</p>
            ) : (
              <form onSubmit={handleAppeal} className="flex flex-col gap-2">
                <label className="text-xs font-medium text-gray-700">Appeal this decision</label>
                <textarea
                  className="input min-h-20 resize-y text-sm"
                  required
                  maxLength={2000}
                  value={appealMessage}
                  onChange={(e) => setAppealMessage(e.target.value)}
                  placeholder="Explain why this task should be published..."
                />
                {appealError && <p className="text-xs text-red-600">{appealError}</p>}
                <button
                  type="submit"
                  disabled={appealSubmitting || !appealMessage.trim()}
                  className="btn-secondary py-2 text-sm self-start disabled:opacity-50"
                >
                  {appealSubmitting ? 'Submitting…' : 'Submit appeal'}
                </button>
              </form>
            )}
          </div>
        )}

        {result?.buyer_token && !result?.moderation_status && (
          <div className="mt-4 bg-blue-50 border border-blue-300 rounded-lg p-4 text-left">
            {result.moderation_warning && (
              <div className="mb-3 bg-amber-50 border border-amber-300 rounded p-3">
                <p className="text-xs font-semibold text-amber-800 mb-1">⚠️ Published with a warning</p>
                <p className="text-sm text-amber-800">{result.moderation_warning}</p>
              </div>
            )}
            <p className="text-sm font-semibold text-blue-800 mb-2">🔑 Your buyer token — save it to approve or dispute this task</p>
            <code className="block text-xs font-mono bg-white border border-blue-200 rounded p-3 break-all select-all">
              {result.buyer_token}
            </code>
            <p className="text-xs text-blue-600 mt-2">{result.buyer_token_note}</p>
            <button
              type="button"
              onClick={() => router.push('/buyer/dashboard')}
              className="mt-3 btn-primary py-2 text-sm"
            >
              Go to Dashboard
            </button>
          </div>
        )}
    </div>
  )
}
