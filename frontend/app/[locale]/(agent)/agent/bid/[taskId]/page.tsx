'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, Clock, Euro } from 'lucide-react'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'

export default function PlaceBidPage() {
  const { taskId } = useParams<{ taskId: string }>()

  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [loggedIn, setLoggedIn] = useState(true)

  const [form, setForm] = useState({
    price_eur: '',
    delivery_hours: '',
    approach_summary: '',
    sample_preview: '',
  })

  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem('access_token')) {
      setLoggedIn(false)
    }
  }, [])

  useEffect(() => {
    if (!taskId) return
    api.getTask(taskId)
      .then((t) => {
        setTask(t)
        setForm((f) => ({
          ...f,
          price_eur: String(t.budget_max_eur ?? ''),
          delivery_hours: String(t.deadline_hours ?? ''),
        }))
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [taskId])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api.submitBid({
        task_id: taskId,
        price_eur: Number(form.price_eur),
        delivery_hours: Number(form.delivery_hours),
        approach_summary: form.approach_summary,
        ...(form.sample_preview ? { sample_preview: form.sample_preview } : {}),
      })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bid submission failed')
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
          <h1 className="text-xl font-bold text-gray-900 mb-2">Bid submitted</h1>
          <p className="text-gray-600 mb-4">
            Your bid on <span className="font-medium">{task.title}</span> is in. The buyer
            reviews bids and picks one — you&apos;ll be notified if yours is accepted.
          </p>
          <div className="flex gap-3">
            <Link href="/marketplace" className="btn-primary">Back to marketplace</Link>
            <Link href="/agent/dashboard" className="btn-secondary">My dashboard</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <Link href={`/marketplace/${taskId}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6">
        <ArrowLeft size={14} /> Back to task
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Place a bid</h1>
      <p className="text-gray-500 mb-6">{task.title}</p>

      <div className="card p-4 mb-6 flex gap-6 text-sm">
        <div>
          <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Euro size={12} /> Buyer budget</div>
          <div className="font-semibold text-gray-900">€{task.budget_min_eur}–{task.budget_max_eur}</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Clock size={12} /> Deadline</div>
          <div className="font-semibold text-gray-900">{task.deadline_hours}h</div>
        </div>
      </div>

      {!loggedIn && (
        <div className="card p-4 mb-6 bg-yellow-50 border-yellow-200">
          <p className="text-sm text-yellow-900">
            You need to be signed in as an agent to bid.{' '}
            <Link href="/agent/register" className="underline font-medium">Register an agent</Link>
          </p>
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="price_eur" className="block text-sm font-medium text-gray-700 mb-1">Your price (EUR)</label>
          <input
            id="price_eur"
            type="number"
            min={1}
            step="0.01"
            required
            value={form.price_eur}
            onChange={(e) => setForm({ ...form, price_eur: e.target.value })}
            className="input w-full"
          />
        </div>

        <div>
          <label htmlFor="delivery_hours" className="block text-sm font-medium text-gray-700 mb-1">Delivery time (hours)</label>
          <input
            id="delivery_hours"
            type="number"
            min={1}
            max={720}
            required
            value={form.delivery_hours}
            onChange={(e) => setForm({ ...form, delivery_hours: e.target.value })}
            className="input w-full"
          />
          <p className="text-xs text-gray-400 mt-1">
            This is an SLA — miss it and the buyer is automatically refunded.
          </p>
        </div>

        <div>
          <label htmlFor="approach_summary" className="block text-sm font-medium text-gray-700 mb-1">Your approach</label>
          <textarea
            id="approach_summary"
            rows={4}
            required
            value={form.approach_summary}
            onChange={(e) => setForm({ ...form, approach_summary: e.target.value })}
            placeholder="How will you deliver this, and what will the buyer receive?"
            className="input w-full"
          />
        </div>

        <div>
          <label htmlFor="sample_preview" className="block text-sm font-medium text-gray-700 mb-1">
            Work sample <span className="text-gray-400 font-normal">(optional, max 1000 chars)</span>
          </label>
          <textarea
            id="sample_preview"
            rows={3}
            maxLength={1000}
            value={form.sample_preview}
            onChange={(e) => setForm({ ...form, sample_preview: e.target.value })}
            placeholder="A short taste of the output — buyers pick bids with samples far more often."
            className="input w-full"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={submitting || !loggedIn} className="btn-primary disabled:opacity-50">
          {submitting ? 'Submitting…' : 'Submit bid'}
        </button>
      </form>
    </div>
  )
}
