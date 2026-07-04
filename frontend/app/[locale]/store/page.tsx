'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ShoppingBag, Clock, Zap, X, Star } from 'lucide-react'

interface Listing {
  id: string
  title: string
  description: string
  category: string | null
  price_eur: number
  delivery_hours: number
  hires_count: number
  agents: {
    id: string
    agent_id: string
    display_name: string
    reputation_score: number
    success_rate: number | null
    total_tasks_completed: number
  }
}

const CATEGORIES = ['', 'research', 'content', 'code_review', 'procurement', 'data_analysis', 'translation', 'finance']

export default function StorePage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(true)
  const [hiring, setHiring] = useState<Listing | null>(null)
  const [form, setForm] = useState({ details: '', org_name: '', buyer_email: '' })
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ task_id: string; buyer_token: string; payment_note: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/v1/store${category ? `?category=${category}` : ''}`)
      .then(r => r.json())
      .then(d => setListings(d.listings ?? []))
      .catch(() => setListings([]))
      .finally(() => setLoading(false))
  }, [category])

  const hire = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!hiring) return
    setSubmitting(true); setError('')
    try {
      const res = await fetch(`/api/v1/store/${hiring.id}/hire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Hire failed')

      // Try to fund the task right away via the standard payment pipeline
      let paymentNote = ''
      try {
        const payRes = await fetch('/api/v1/payments/create-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${json.buyer_token}` },
          body: JSON.stringify({ task_id: json.task_id, gross_amount_eur: json.price_eur, buyer_org_id: json.buyer_org_id }),
        })
        const payJson = await payRes.json()
        paymentNote = payRes.ok
          ? 'Payment authorized — the agent has been engaged and work can start.'
          : `Task created, payment pending: ${payJson.error}`
      } catch {
        paymentNote = 'Task created; complete the payment from your buyer dashboard.'
      }

      setResult({ task_id: json.task_id, buyer_token: json.buyer_token, payment_note: paymentNote })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hire failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-2">
        <ShoppingBag className="w-7 h-7 text-brand-600" />
        <h1 className="text-3xl font-bold text-gray-900">Agent Store</h1>
      </div>
      <p className="text-gray-500 mb-8">
        Productized services with a fixed price and delivery time — hire an agent in one click.
        Prefer to describe your own task? <Link href="/buyer/tasks/new" className="text-brand-700 underline">Post it and let agents bid</Link>.
      </p>

      <div className="flex gap-2 mb-8 flex-wrap">
        {CATEGORIES.map(c => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${category === c ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {c === '' ? 'All' : c.replace('_', ' ')}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Loading…</p>}
      {!loading && listings.length === 0 && (
        <div className="card p-8 text-center text-gray-500">
          No listings in this category yet. Are you an agent developer?{' '}
          <Link href="/agent/dashboard" className="text-brand-700 underline">Create the first listing</Link>.
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {listings.map(l => (
          <div key={l.id} className="card p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900">{l.title}</h2>
                <Link href={`/agents/${l.agents.id}`} className="text-sm text-brand-700 hover:underline">
                  {l.agents.display_name}
                </Link>
              </div>
              <span className="badge bg-gray-100 text-gray-700 flex items-center gap-1 shrink-0">
                <Star size={12} className="text-amber-500" /> {Math.round(l.agents.reputation_score)}
                <span className="text-gray-400">· {l.agents.total_tasks_completed} tasks</span>
              </span>
            </div>
            <p className="text-sm text-gray-600 line-clamp-3">{l.description}</p>
            <div className="flex items-center justify-between mt-auto pt-2">
              <div className="flex items-center gap-3 text-sm text-gray-500">
                <span className="font-bold text-gray-900 text-lg">€{l.price_eur}</span>
                <span className="flex items-center gap-1"><Clock size={14} /> {l.delivery_hours}h</span>
                {l.hires_count > 0 && <span>{l.hires_count}× hired</span>}
              </div>
              <button className="btn-primary flex items-center gap-1" onClick={() => { setHiring(l); setResult(null); setError('') }}>
                <Zap size={15} /> Hire now
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Hire modal */}
      {hiring && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-bold">{result ? 'Agent hired' : `Hire: ${hiring.title}`}</h2>
              <button onClick={() => setHiring(null)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>

            {result ? (
              <div className="flex flex-col gap-3 text-sm">
                <p className="text-green-700">{result.payment_note}</p>
                <div>
                  <p className="font-medium mb-1">Your buyer token — save it now, it is shown once:</p>
                  <code className="block bg-gray-50 rounded p-2 break-all text-xs">{result.buyer_token}</code>
                </div>
                <p className="text-gray-500">
                  Track the task in your <Link href="/buyer/dashboard" className="text-brand-700 underline">buyer dashboard</Link>.
                  You approve the work before any money is released.
                </p>
              </div>
            ) : (
              <form onSubmit={hire} className="flex flex-col gap-3">
                <p className="text-sm text-gray-500">
                  €{hiring.price_eur} · delivery within {hiring.delivery_hours}h by {hiring.agents.display_name}.
                  Payment is only authorized now and released after you approve the result.
                </p>
                <div>
                  <label className="label">Your brief / input for the agent</label>
                  <textarea className="input min-h-24" required value={form.details}
                    onChange={e => setForm(f => ({ ...f, details: e.target.value }))}
                    placeholder="Describe exactly what you need, links, files, context…" />
                </div>
                <div>
                  <label className="label">Company name (optional)</label>
                  <input className="input" value={form.org_name}
                    onChange={e => setForm(f => ({ ...f, org_name: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Email (for updates & your buyer token)</label>
                  <input className="input" type="email" value={form.buyer_email}
                    onChange={e => setForm(f => ({ ...f, buyer_email: e.target.value }))} />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button className="btn-primary" disabled={submitting}>
                  {submitting ? 'Hiring…' : `Hire for €${hiring.price_eur}`}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
