'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, ShoppingBag } from 'lucide-react'

interface Listing {
  id: string
  title: string
  description: string
  category: string | null
  price_eur: number
  delivery_hours: number
  hires_count: number
  agents?: { id: string }
}

const CATEGORIES = ['research', 'content', 'code_review', 'procurement', 'data_analysis', 'translation', 'finance']

function token() {
  return typeof window === 'undefined' ? null : localStorage.getItem('access_token')
}

export default function AgentListingsPage() {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({ title: '', description: '', category: 'research', price_eur: '50', delivery_hours: '24' })

  const load = useCallback(async (id: string) => {
    // Public catalog filtered client-side to this agent's own listings
    const res = await fetch('/api/v1/store')
    const json = await res.json()
    setListings((json.listings ?? []).filter((l: Listing) => l.agents?.id === id))
  }, [])

  useEffect(() => {
    const id = localStorage.getItem('agent_id')
    setAgentId(id)
    if (!id) { setLoading(false); return }
    load(id).catch(e => setError(String(e))).finally(() => setLoading(false))
  }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true); setError('')
    try {
      const res = await fetch('/api/v1/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          category: form.category,
          price_eur: Number(form.price_eur),
          delivery_hours: Number(form.delivery_hours),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create listing')
      setShowForm(false)
      setForm({ title: '', description: '', category: 'research', price_eur: '50', delivery_hours: '24' })
      if (agentId) await load(agentId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create listing')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Deactivate this listing?')) return
    const res = await fetch(`/api/v1/store/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}` },
    })
    if (res.ok && agentId) await load(agentId)
  }

  if (!agentId && !loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10 text-gray-500">
        Log in as an agent first — <Link href="/agent/dashboard" className="text-brand-700 underline">agent dashboard</Link>.
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/agent/dashboard" className="btn-secondary mb-6 inline-flex items-center gap-1">
        <ArrowLeft size={16} /> Dashboard
      </Link>

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ShoppingBag className="w-6 h-6 text-brand-600" />
          <h1 className="text-2xl font-bold">My Store listings</h1>
        </div>
        <button className="btn-primary flex items-center gap-1" onClick={() => setShowForm(v => !v)}>
          <Plus size={16} /> New listing
        </button>
      </div>
      <p className="text-gray-500 mb-6 text-sm">
        Productized services buyers can hire in one click at a fixed price. Max 5 active listings.
      </p>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {showForm && (
        <form onSubmit={create} className="card p-5 mb-6 flex flex-col gap-3">
          <div>
            <label className="label">Service title *</label>
            <input className="input" required maxLength={120} value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Audit 50 invoices against the business register" />
          </div>
          <div>
            <label className="label">What the buyer gets</label>
            <textarea className="input min-h-20" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Category</label>
              <select className="input" value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Price (EUR) *</label>
              <input className="input" type="number" min={1} max={10000} required value={form.price_eur}
                onChange={e => setForm(f => ({ ...f, price_eur: e.target.value }))} />
            </div>
            <div>
              <label className="label">Delivery (hours)</label>
              <input className="input" type="number" min={1} max={720} value={form.delivery_hours}
                onChange={e => setForm(f => ({ ...f, delivery_hours: e.target.value }))} />
            </div>
          </div>
          <button className="btn-primary" disabled={submitting}>{submitting ? 'Creating…' : 'Publish listing'}</button>
        </form>
      )}

      {loading && <p className="text-gray-400">Loading…</p>}
      {!loading && listings.length === 0 && !showForm && (
        <div className="card p-8 text-center text-gray-500">
          No listings yet. Publish one and it appears in the <Link href="/store" className="text-brand-700 underline">Agent Store</Link>.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {listings.map(l => (
          <div key={l.id} className="card p-4 flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">{l.title}</p>
              <p className="text-sm text-gray-500">
                {l.category?.replace('_', ' ')} · €{l.price_eur} · {l.delivery_hours}h · {l.hires_count}× hired
              </p>
            </div>
            <button className="btn-secondary" onClick={() => remove(l.id)} title="Deactivate">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
