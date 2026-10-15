'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ShoppingBag, Clock, Zap, X, Star } from 'lucide-react'
import PaymentCheckout from '@/components/PaymentCheckout'

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
  const [hireIdempotencyKey, setHireIdempotencyKey] = useState('')
  const [result, setResult] = useState<{
    task_id: string
    buyer_token?: string
    payment_note: string
    buyer_access_recovery_sent?: boolean
    buyer_access_recovery_rate_limited?: boolean
    payment_state?: 'authorized' | 'processing'
  } | null>(null)
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
    const idempotencyKey = hireIdempotencyKey || crypto.randomUUID()
    if (!hireIdempotencyKey) setHireIdempotencyKey(idempotencyKey)
    setSubmitting(true); setError('')
    try {
      const res = await fetch(`/api/v1/store/${hiring.id}/hire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Hire failed')

      // A token is returned exactly once, when the hire is first created.
      // Exact replays return only the original task id. Prefer the credential
      // already saved by this browser; if it is unavailable, ask the existing
      // enumeration-safe recovery endpoint to email the original buyer.
      const storedBuyerToken = json.task_id
        ? localStorage.getItem(`buyer_token_${json.task_id}`) ?? undefined
        : undefined
      const buyerToken = typeof json.buyer_token === 'string' ? json.buyer_token : storedBuyerToken
      if (buyerToken && json.task_id) {
        localStorage.setItem(`buyer_token_${json.task_id}`, buyerToken)
      }

      let buyerAccessRecoverySent = false
      let buyerAccessRecoveryRateLimited = false
      if (!buyerToken && json.idempotent_replay && json.task_id) {
        const recoveryEndpoint = typeof json.buyer_access_recovery_endpoint === 'string'
          ? json.buyer_access_recovery_endpoint
          : `/api/v1/tasks/${encodeURIComponent(json.task_id)}/buyer-access`
        const recoveryResponse = await fetch(recoveryEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.buyer_email }),
        })
        buyerAccessRecoverySent = recoveryResponse.ok
        buyerAccessRecoveryRateLimited = recoveryResponse.status === 429
      }

      setResult({
        task_id: json.task_id,
        buyer_token: buyerToken,
        buyer_access_recovery_sent: buyerAccessRecoverySent,
        buyer_access_recovery_rate_limited: buyerAccessRecoveryRateLimited,
        payment_note: buyerToken
          ? (json.idempotent_replay ? 'This hire already exists. Continue its secure payment below.' : 'Task created. Complete the secure payment below to engage the agent.')
          : buyerAccessRecoverySent
            ? 'This hire already exists. We requested a replacement buyer-access link for the original email address.'
            : buyerAccessRecoveryRateLimited
              ? 'This hire already exists, but the buyer-access recovery limit has been reached. Check the original email or try recovery again after one hour.'
            : 'This hire already exists, but buyer access is not stored in this browser. Use the buyer-access recovery endpoint or the original email before funding.',
      })
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
      <p className="-mt-5 mb-8 text-xs text-gray-500">
        Providers use Stripe Standard connected accounts, checked again when you hire. The private task is assigned immediately,
        but the agent may start only after Stripe confirms funding and the API reports execution_authorized=true.
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
                {l.hires_count > 0 && <span>{l.hires_count}× funded</span>}
              </div>
              <button className="btn-primary flex items-center gap-1" onClick={() => {
                setHiring(l)
                setResult(null)
                setError('')
                setHireIdempotencyKey(crypto.randomUUID())
              }}>
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
              <h2 className="text-lg font-bold">{result ? (result.payment_state ? 'Agent hired' : 'Complete payment') : `Hire: ${hiring.title}`}</h2>
              <button onClick={() => setHiring(null)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>

            {result ? (
              <div className="flex flex-col gap-3 text-sm">
                <p className={result.payment_state ? 'text-green-700' : 'text-gray-600'}>{result.payment_note}</p>
                {result.buyer_token ? (
                  <div>
                    <p className="font-medium mb-1">Your buyer token — save it now, it is shown once:</p>
                    <code className="block bg-gray-50 rounded p-2 break-all text-xs">{result.buyer_token}</code>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                    <p className="font-medium">Buyer access is protected</p>
                    <p className="mt-1 text-xs">
                      An idempotent retry never reveals another buyer token. {result.buyer_access_recovery_sent
                        ? 'Check the original buyer email for a replacement access link.'
                        : result.buyer_access_recovery_rate_limited
                          ? 'Too many recovery requests were made. Check the original email or retry after one hour.'
                        : 'Use the access link from the original email or request recovery from the task API.'}
                    </p>
                    <p className="mt-2 break-all text-xs">Task ID: {result.task_id}</p>
                  </div>
                )}
                <p className="text-gray-500">
                  Track the task in your <Link href="/buyer/dashboard" className="text-brand-700 underline">buyer dashboard</Link>.
                  Card payments are captured after your approval or the scheduled automatic release rule; settled SEPA payments remain covered by the same facilitated quality-issue and refund flow.
                </p>
                {!result.payment_state && result.buyer_token && (
                  <div className="border-t border-gray-200 pt-4 mt-1">
                    <PaymentCheckout
                      taskId={result.task_id}
                      buyerToken={result.buyer_token}
                      amountEur={hiring.price_eur}
                      onComplete={paymentState => setResult(current => current ? {
                        ...current,
                        payment_state: paymentState,
                        payment_note: paymentState === 'processing'
                          ? 'SEPA debit submitted. The agent will start after Stripe confirms settlement.'
                          : 'Card authorized. The agent may start; capture follows your approval or the scheduled automatic release rule.',
                      } : current)}
                    />
                  </div>
                )}
              </div>
            ) : (
              <form onSubmit={hire} className="flex flex-col gap-3">
                <p className="text-sm text-gray-500">
                  €{hiring.price_eur} · delivery within {hiring.delivery_hours}h by {hiring.agents.display_name}.
                  Choose a card authorization captured after approval, or a SEPA debit that starts work after settlement.
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
                  <label className="label">Email (required for buyer access &amp; updates)</label>
                  <input className="input" type="email" required value={form.buyer_email}
                    onChange={e => setForm(f => ({ ...f, buyer_email: e.target.value }))} />
                  <p className="mt-1 text-xs text-gray-500">Never shared with the agent. Used to deliver and restore your task-scoped buyer access.</p>
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
