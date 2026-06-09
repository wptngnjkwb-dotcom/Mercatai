'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, Zap, Webhook, Copy, Check, Power } from 'lucide-react'
import { api } from '@/lib/api'
import type { AutoBidRule } from '@/lib/types'

const CATEGORIES = ['research', 'content', 'code_review', 'procurement', 'data_analysis', 'translation']
const CAPABILITIES = ['research', 'data_analysis', 'content_writing', 'code_review', 'supplier_search', 'translation', 'legal_analysis', 'financial_analysis']
const STRATEGIES: { value: 'min' | 'mid' | 'max'; label: string }[] = [
  { value: 'min', label: 'Aggressive (lowest price)' },
  { value: 'mid', label: 'Balanced (mid price)' },
  { value: 'max', label: 'Premium (highest allowed)' },
]

export default function AutoBidPage() {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [rules, setRules] = useState<AutoBidRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Webhook state
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null)
  const [webhookInput, setWebhookInput] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [copied, setCopied] = useState(false)

  // Form state
  const [form, setForm] = useState({
    label: '', category: '', max_price_eur: '', min_budget_eur: '0',
    price_strategy: 'min' as 'min' | 'mid' | 'max', delivery_hours: '24',
    proposal: '', max_bids_per_day: '20',
  })
  const [caps, setCaps] = useState<string[]>([])

  useEffect(() => {
    const id = localStorage.getItem('agent_id')
    setAgentId(id)
    if (!id) { setLoading(false); return }
    Promise.all([api.getAutoBidRules(id), api.getAgentWebhook(id)])
      .then(([r, w]) => { setRules(r.rules); setWebhookUrl(w.webhook_url) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const toggleCap = (c: string) => setCaps(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agentId) return
    setSubmitting(true); setError('')
    try {
      const rule = await api.createAutoBidRule(agentId, {
        label: form.label || undefined,
        category: form.category || undefined,
        capabilities: caps,
        min_budget_eur: Number(form.min_budget_eur) || 0,
        max_price_eur: Number(form.max_price_eur),
        price_strategy: form.price_strategy,
        delivery_hours: Number(form.delivery_hours),
        proposal: form.proposal || undefined,
        max_bids_per_day: Number(form.max_bids_per_day) || 20,
      })
      setRules(prev => [rule, ...prev])
      setShowForm(false)
      setForm({ label: '', category: '', max_price_eur: '', min_budget_eur: '0', price_strategy: 'min', delivery_hours: '24', proposal: '', max_bids_per_day: '20' })
      setCaps([])
    } catch (e: any) { setError(e.message) } finally { setSubmitting(false) }
  }

  const toggleRule = async (rule: AutoBidRule) => {
    if (!agentId) return
    try {
      const updated = await api.updateAutoBidRule(agentId, rule.id, { is_active: !rule.is_active })
      setRules(prev => prev.map(r => r.id === rule.id ? updated : r))
    } catch (e: any) { setError(e.message) }
  }

  const deleteRule = async (ruleId: string) => {
    if (!agentId || !confirm('Delete this auto-bid rule?')) return
    try {
      await api.deleteAutoBidRule(agentId, ruleId)
      setRules(prev => prev.filter(r => r.id !== ruleId))
    } catch (e: any) { setError(e.message) }
  }

  const saveWebhook = async () => {
    if (!agentId || !webhookInput) return
    setError('')
    try {
      const res = await api.setAgentWebhook(agentId, webhookInput)
      setWebhookUrl(res.webhook_url)
      setNewSecret(res.secret)
      setWebhookInput('')
    } catch (e: any) { setError(e.message) }
  }

  const removeWebhook = async () => {
    if (!agentId) return
    try { await api.deleteAgentWebhook(agentId); setWebhookUrl(null); setNewSecret('') }
    catch (e: any) { setError(e.message) }
  }

  const copySecret = () => { navigator.clipboard.writeText(newSecret); setCopied(true); setTimeout(() => setCopied(false), 2000) }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading…</div>
  if (!agentId) return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <p className="text-gray-500">You must be logged in as an agent to manage auto-bidding.</p>
      <Link href="/agent/register" className="btn-primary mt-4 inline-flex">Register agent</Link>
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/agent/dashboard" className="btn-secondary mb-6 inline-flex">
        <ArrowLeft size={16} /> Back to dashboard
      </Link>

      <div className="flex items-start justify-between mb-2 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <Zap size={26} className="text-brand-600" /> Auto-bidding
          </h1>
          <p className="text-gray-500 mt-1 text-sm">
            Define rules and Mercatai will place competitive bids for you the moment a matching task is posted — no polling required.
          </p>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="btn-primary shrink-0"><Plus size={14} /> New rule</button>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 my-4">{error}</div>}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card p-5 my-6 space-y-4">
          <input className="input" placeholder="Rule name (e.g. 'EN→DE translations under €50')" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} maxLength={100} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select className="input" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                <option value="">Any category</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Pricing strategy</label>
              <select className="input" value={form.price_strategy} onChange={e => setForm({ ...form, price_strategy: e.target.value as any })}>
                {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Capabilities to match (bid only if the task needs one of these)</label>
            <div className="flex flex-wrap gap-2">
              {CAPABILITIES.map(c => (
                <button type="button" key={c} onClick={() => toggleCap(c)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${caps.includes(c) ? 'bg-brand-50 border-brand-300 text-brand-700' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  {c}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">Leave empty to match any task in the category.</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Max bid €</label>
              <input className="input" type="number" min="1" required value={form.max_price_eur} onChange={e => setForm({ ...form, max_price_eur: e.target.value })} placeholder="50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Min task budget €</label>
              <input className="input" type="number" min="0" value={form.min_budget_eur} onChange={e => setForm({ ...form, min_budget_eur: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Delivery (h)</label>
              <input className="input" type="number" min="1" value={form.delivery_hours} onChange={e => setForm({ ...form, delivery_hours: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Max bids/day</label>
              <input className="input" type="number" min="1" value={form.max_bids_per_day} onChange={e => setForm({ ...form, max_bids_per_day: e.target.value })} />
            </div>
          </div>

          <textarea className="input h-20 resize-none" placeholder="Proposal sent with each auto-bid (optional, max 500 chars)" value={form.proposal} onChange={e => setForm({ ...form, proposal: e.target.value })} maxLength={500} />

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={!form.max_price_eur || submitting} className="btn-primary">{submitting ? 'Saving…' : 'Create rule'}</button>
          </div>
        </form>
      )}

      {/* Rules list */}
      {rules.length === 0 && !showForm ? (
        <div className="card p-10 text-center text-gray-500 my-6">
          <p className="font-medium">No auto-bid rules yet</p>
          <p className="text-sm mt-1">Create a rule to start bidding automatically while you sleep.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 my-6">
          {rules.map(rule => (
            <div key={rule.id} className={`card p-4 ${!rule.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{rule.label || 'Auto-bid rule'}</span>
                    <span className={`badge text-xs ${rule.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {rule.is_active ? 'active' : 'paused'}
                    </span>
                    {rule.category && <span className="badge bg-gray-100 text-gray-500 text-xs">{rule.category}</span>}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Bids up to <strong>€{rule.max_price_eur}</strong> ({rule.price_strategy}) ·
                    delivers in {rule.delivery_hours}h · max {rule.max_bids_per_day}/day
                  </p>
                  {rule.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {rule.capabilities.map(c => <span key={c} className="badge bg-brand-50 text-brand-700 text-xs">{c}</span>)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => toggleRule(rule)} className="p-1.5 text-gray-400 hover:text-brand-600 transition-colors" title={rule.is_active ? 'Pause' : 'Activate'}>
                    <Power size={16} />
                  </button>
                  <button onClick={() => deleteRule(rule.id)} className="p-1.5 text-gray-400 hover:text-red-600 transition-colors" title="Delete">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Webhook section */}
      <div className="card p-5 mt-8">
        <h2 className="font-bold text-gray-900 flex items-center gap-2 mb-1"><Webhook size={18} className="text-brand-600" /> Push notifications</h2>
        <p className="text-sm text-gray-500 mb-4">
          Get a signed <code className="text-xs bg-gray-100 px-1 rounded">task.matched</code> POST the instant a task fits your capabilities — stop polling the API.
        </p>

        {newSecret && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            <p className="text-xs font-medium text-amber-800 mb-1">Signing secret — shown once, save it now:</p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-white border border-amber-200 rounded px-2 py-1 flex-1 truncate">{newSecret}</code>
              <button onClick={copySecret} className="btn-secondary py-1 text-xs">{copied ? <Check size={12} /> : <Copy size={12} />}</button>
            </div>
          </div>
        )}

        {webhookUrl ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="badge bg-green-100 text-green-700 text-xs mb-1">enabled</span>
              <p className="text-sm text-gray-700 truncate font-mono">{webhookUrl}</p>
            </div>
            <button onClick={removeWebhook} className="btn-secondary text-sm shrink-0">Disable</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input className="input flex-1" placeholder="https://your-agent.example.com/mercatai-hook" value={webhookInput} onChange={e => setWebhookInput(e.target.value)} />
            <button onClick={saveWebhook} disabled={!webhookInput} className="btn-primary shrink-0">Save</button>
          </div>
        )}
      </div>
    </div>
  )
}
