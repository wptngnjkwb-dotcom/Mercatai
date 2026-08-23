'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ShieldAlert, RefreshCw, Check, EyeOff, Ban, Flag, UserX, ArrowLeft } from 'lucide-react'

interface ModTask {
  id: string
  title: string
  description: string
  category: string
  budget_min_eur: number
  budget_max_eur: number
  moderation_status: 'pending' | 'approved' | 'quarantined' | 'rejected'
  moderation_risk_score: number | null
  moderation_reason_codes: string[]
  moderation_policy_version: string | null
  moderated_at: string | null
  moderated_by: string | null
  created_at: string
  posted_by_org_id: string
  organization_name: string | null
  organization_suspended: boolean
  report_count: number
}

interface Appeal {
  id: string
  task_id: string
  task_title: string | null
  buyer_org_id: string
  organization_name: string | null
  message: string
  status: string
  created_at: string
}

interface QueueResponse {
  tasks: ModTask[]
  appeals: Appeal[]
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

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  quarantined: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-700',
  approved: 'bg-green-100 text-green-700',
}

export default function ModerationQueuePage() {
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [data, setData] = useState<QueueResponse | null>(null)
  const [statusFilter, setStatusFilter] = useState<'queue' | 'approved' | 'rejected'>('queue')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (tok: string, filter: 'queue' | 'approved' | 'rejected') => {
    setBusy(true); setError('')
    try {
      const qs = filter === 'queue' ? '' : `?status=${filter}`
      const res: QueueResponse = await adminFetch(`/moderation${qs}`, tok)
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      if (String(e).includes('Admin token')) { setToken(null); sessionStorage.removeItem('admin_token') }
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    const tok = sessionStorage.getItem('admin_token')
    if (tok) { setToken(tok); load(tok, statusFilter) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      await load(json.access_token, statusFilter)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  const changeFilter = (filter: 'queue' | 'approved' | 'rejected') => {
    setStatusFilter(filter)
    if (token) load(token, filter)
  }

  const act = async (taskId: string, action: 'approve' | 'quarantine' | 'reject') => {
    if (!token) return
    const note = action === 'approve' ? undefined : window.prompt(`Optional note for this ${action} decision:`) || undefined
    try {
      await adminFetch(`/moderation/${taskId}`, token, { method: 'PUT', body: JSON.stringify({ action, note }) })
      await load(token, statusFilter)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    }
  }

  const suspendOrg = async (orgId: string, orgName: string | null, taskId: string) => {
    if (!token) return
    if (!confirm(`Suspend organization "${orgName ?? orgId}"? They will not be able to post new tasks or instant-hire.`)) return
    const reason = window.prompt('Reason for suspension (shown in the audit log):') || undefined
    try {
      await adminFetch(`/organizations/${orgId}/suspend`, token, { method: 'PUT', body: JSON.stringify({ suspended: true, reason, task_id: taskId }) })
      await load(token, statusFilter)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suspend failed')
    }
  }

  const resolveAppeal = async (appealId: string, resolution: 'uphold' | 'overturn') => {
    if (!token) return
    const statement_of_reasons = window.prompt(
      resolution === 'overturn'
        ? 'Statement of reasons for overturning this decision (shown to the buyer):'
        : 'Statement of reasons for upholding this decision (shown to the buyer):'
    )
    if (!statement_of_reasons || !statement_of_reasons.trim()) return
    try {
      await adminFetch(`/moderation/appeals/${appealId}`, token, { method: 'PUT', body: JSON.stringify({ resolution, statement_of_reasons }) })
      await load(token, statusFilter)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Appeal resolution failed')
    }
  }

  if (!token) {
    return (
      <div className="max-w-sm mx-auto mt-20 card p-6">
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert className="w-5 h-5 text-brand-700" />
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
          <ShieldAlert className="w-6 h-6 text-brand-700" />
          <h1 className="text-2xl font-bold">Moderation queue</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin" className="btn-secondary flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> Back-office
          </Link>
          <button className="btn-secondary flex items-center gap-1" onClick={() => load(token, statusFilter)} disabled={busy}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        {(['queue', 'approved', 'rejected'] as const).map(f => (
          <button
            key={f}
            className={f === statusFilter ? 'btn-primary text-sm' : 'btn-secondary text-sm'}
            onClick={() => changeFilter(f)}
          >
            {f === 'queue' ? 'Pending + quarantined' : f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {data && (
        <>
          {/* Pending appeals */}
          <section>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Flag className="w-4 h-4 text-amber-600" /> Pending appeals
            </h2>
            {data.appeals.length === 0 && <p className="text-sm text-gray-400">No pending appeals.</p>}
            <div className="flex flex-col gap-2">
              {data.appeals.map(a => (
                <div key={a.id} className="card p-4 flex flex-col md:flex-row md:items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{a.task_title ?? a.task_id}</p>
                    <p className="text-sm text-gray-500">{a.organization_name ?? a.buyer_org_id}</p>
                    <p className="text-sm mt-2 whitespace-pre-wrap bg-gray-50 rounded p-2">{a.message}</p>
                    <p className="text-xs text-gray-400 mt-1">Filed {new Date(a.created_at).toLocaleString()}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button className="btn-secondary flex items-center gap-1" onClick={() => resolveAppeal(a.id, 'uphold')}>
                      <Ban className="w-4 h-4" /> Uphold
                    </button>
                    <button className="btn-primary flex items-center gap-1" onClick={() => resolveAppeal(a.id, 'overturn')}>
                      <Check className="w-4 h-4" /> Overturn
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Task queue */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Tasks</h2>
            {data.tasks.length === 0 && <p className="text-sm text-gray-400">Nothing here.</p>}
            <div className="flex flex-col gap-2">
              {data.tasks.map(t => (
                <div key={t.id} className="card p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium">{t.title}</p>
                        <span className={`badge ${STATUS_BADGE[t.moderation_status] ?? 'bg-gray-100 text-gray-700'}`}>{t.moderation_status}</span>
                        {t.moderation_risk_score !== null && <span className="badge bg-gray-100 text-gray-600">risk {t.moderation_risk_score}</span>}
                        {t.report_count > 0 && <span className="badge bg-amber-100 text-amber-800">{t.report_count} report{t.report_count === 1 ? '' : 's'}</span>}
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        {t.category} · up to €{t.budget_max_eur} · {t.organization_name ?? t.posted_by_org_id}
                        {t.organization_suspended && <span className="text-red-600 font-medium"> · org suspended</span>}
                      </p>
                      {t.moderation_reason_codes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {t.moderation_reason_codes.map(code => (
                            <span key={code} className="badge bg-gray-100 text-gray-600 text-xs">{code}</span>
                          ))}
                        </div>
                      )}
                      <details className="mt-2 text-sm">
                        <summary className="cursor-pointer text-gray-600">Description</summary>
                        <p className="mt-1 text-gray-600 whitespace-pre-wrap">{t.description}</p>
                      </details>
                      <p className="text-xs text-gray-400 mt-1">
                        Posted {new Date(t.created_at).toLocaleString()}
                        {t.moderated_at && ` · moderated ${new Date(t.moderated_at).toLocaleString()} (${t.moderated_by})`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 shrink-0">
                      <button className="btn-secondary flex items-center gap-1 text-sm" onClick={() => act(t.id, 'approve')}>
                        <Check className="w-4 h-4" /> Approve
                      </button>
                      <button className="btn-secondary flex items-center gap-1 text-sm" onClick={() => act(t.id, 'quarantine')}>
                        <EyeOff className="w-4 h-4" /> Quarantine
                      </button>
                      <button className="btn-secondary flex items-center gap-1 text-sm" onClick={() => act(t.id, 'reject')}>
                        <Ban className="w-4 h-4" /> Reject
                      </button>
                      {!t.organization_suspended && (
                        <button className="btn-secondary flex items-center gap-1 text-sm text-red-700" onClick={() => suspendOrg(t.posted_by_org_id, t.organization_name, t.id)}>
                          <UserX className="w-4 h-4" /> Suspend org
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
