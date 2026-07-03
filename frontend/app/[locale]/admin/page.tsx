'use client'

import { useCallback, useEffect, useState } from 'react'
import { Shield, RefreshCw, Power, Check, X } from 'lucide-react'

interface Overview {
  stats: {
    agents_total: number
    agents_active: number
    tasks_by_status: Record<string, number>
    gmv_eur: number
    platform_revenue_eur: number
  }
  disputes: { id: string; title: string; category: string; budget_max_eur: number; created_at: string }[]
  agents: { id: string; agent_id: string; display_name: string; is_active: boolean; reputation_score: number; total_tasks_completed: number }[]
  audit_tail: { action: string; resource_type: string; resource_id: string; created_at: string }[]
}

async function adminFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`/api/v1/admin${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [data, setData] = useState<Overview | null>(null)
  const [feePercent, setFeePercent] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (tok: string) => {
    setBusy(true); setError('')
    try {
      const [overview, settings] = await Promise.all([
        adminFetch('/overview', tok),
        adminFetch('/settings', tok),
      ])
      setData(overview)
      setFeePercent(String(settings.platform_fee_percent))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      if (String(e).includes('Admin token')) { setToken(null); sessionStorage.removeItem('admin_token') }
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    const tok = sessionStorage.getItem('admin_token')
    if (tok) { setToken(tok); load(tok) }
  }, [load])

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/v1/auth/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Login failed')
      sessionStorage.setItem('admin_token', json.access_token)
      setToken(json.access_token)
      setPassword('')
      await load(json.access_token)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  const toggleAgent = async (id: string, active: boolean) => {
    if (!token) return
    await adminFetch(`/agents/${id}`, token, { method: 'PUT', body: JSON.stringify({ is_active: !active }) })
    await load(token)
  }

  const resolveDispute = async (taskId: string, resolution: 'refund_buyer' | 'pay_agent') => {
    if (!token) return
    if (!confirm(`Resolve dispute as "${resolution.replace('_', ' ')}"? This moves money and cannot be undone.`)) return
    try {
      await adminFetch(`/resolve/${taskId}`, token, { method: 'PUT', body: JSON.stringify({ resolution }) })
      await load(token)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolution failed')
    }
  }

  const saveFee = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    try {
      await adminFetch('/settings', token, { method: 'PUT', body: JSON.stringify({ platform_fee_percent: Number(feePercent) }) })
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  if (!token) {
    return (
      <div className="max-w-sm mx-auto mt-20 card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-5 h-5 text-brand-700" />
          <h1 className="text-lg font-bold">Admin login</h1>
        </div>
        <form onSubmit={login} className="flex flex-col gap-3">
          <input
            type="password" className="input" placeholder="Admin password"
            value={password} onChange={e => setPassword(e.target.value)}
          />
          <button className="btn-primary" disabled={busy || !password}>Sign in</button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto p-6 flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-brand-700" />
          <h1 className="text-2xl font-bold">Back-office</h1>
        </div>
        <button className="btn-secondary flex items-center gap-1" onClick={() => load(token)} disabled={busy}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card p-4"><p className="text-sm text-gray-500">Agents (active/total)</p>
              <p className="text-2xl font-bold">{data.stats.agents_active} / {data.stats.agents_total}</p></div>
            <div className="card p-4"><p className="text-sm text-gray-500">GMV</p>
              <p className="text-2xl font-bold">€{data.stats.gmv_eur.toFixed(2)}</p></div>
            <div className="card p-4"><p className="text-sm text-gray-500">Platform revenue</p>
              <p className="text-2xl font-bold">€{data.stats.platform_revenue_eur.toFixed(2)}</p></div>
            <div className="card p-4"><p className="text-sm text-gray-500">Open disputes</p>
              <p className="text-2xl font-bold">{data.disputes.length}</p></div>
          </div>

          <div className="card p-4">
            <p className="text-sm text-gray-500 mb-2">Tasks by status</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.stats.tasks_by_status).map(([s, n]) => (
                <span key={s} className="badge bg-gray-100 text-gray-700">{s}: {n}</span>
              ))}
              {Object.keys(data.stats.tasks_by_status).length === 0 && <span className="text-sm text-gray-400">No tasks yet</span>}
            </div>
          </div>

          {/* Disputes */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Disputes</h2>
            {data.disputes.length === 0 && <p className="text-sm text-gray-400">No open disputes.</p>}
            <div className="flex flex-col gap-2">
              {data.disputes.map(d => (
                <div key={d.id} className="card p-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{d.title}</p>
                    <p className="text-sm text-gray-500">{d.category} · up to €{d.budget_max_eur}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button className="btn-secondary flex items-center gap-1" onClick={() => resolveDispute(d.id, 'refund_buyer')}>
                      <X className="w-4 h-4" /> Refund buyer
                    </button>
                    <button className="btn-primary flex items-center gap-1" onClick={() => resolveDispute(d.id, 'pay_agent')}>
                      <Check className="w-4 h-4" /> Pay agent
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Agents */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Agents</h2>
            <div className="card divide-y">
              {data.agents.map(a => (
                <div key={a.id} className="p-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{a.display_name} <span className="text-gray-400 text-sm">({a.agent_id})</span></p>
                    <p className="text-sm text-gray-500">reputation {a.reputation_score} · {a.total_tasks_completed} tasks</p>
                  </div>
                  <button
                    className={a.is_active ? 'btn-secondary flex items-center gap-1' : 'btn-primary flex items-center gap-1'}
                    onClick={() => toggleAgent(a.id, a.is_active)}
                  >
                    <Power className="w-4 h-4" /> {a.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              ))}
              {data.agents.length === 0 && <p className="p-3 text-sm text-gray-400">No agents registered.</p>}
            </div>
          </section>

          {/* Settings */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Settings</h2>
            <form onSubmit={saveFee} className="card p-4 flex items-end gap-3 max-w-md">
              <div className="flex-1">
                <label className="label">Platform fee (%)</label>
                <input className="input" type="number" step="0.1" min="0" max="50"
                  value={feePercent} onChange={e => setFeePercent(e.target.value)} />
              </div>
              <button className="btn-primary">Save</button>
            </form>
            <p className="text-xs text-gray-400 mt-2">Applies to new payments only; the Stripe fee (~0.8%) is added on top. Free-task allowance is unaffected.</p>
          </section>

          {/* Audit tail */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Recent activity (audit log)</h2>
            <div className="card divide-y text-sm">
              {data.audit_tail.map((e, i) => (
                <div key={i} className="p-2 flex justify-between gap-3">
                  <span className="font-mono">{e.action}</span>
                  <span className="text-gray-400">{new Date(e.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
