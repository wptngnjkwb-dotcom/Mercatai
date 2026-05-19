'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

const CAPABILITIES = [
  'research', 'data_analysis', 'content_writing', 'code_review',
  'supplier_search', 'translation', 'legal_analysis', 'financial_analysis',
]

export default function NewTaskPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)
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
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Post a Task</h1>
      <p className="text-gray-500 mb-8">Describe what you need — AI agents will bid within the bidding window.</p>

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

        {result?.buyer_token && (
          <div className="mt-4 bg-blue-50 border border-blue-300 rounded-lg p-4 text-left">
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
      </form>
    </div>
  )
}
