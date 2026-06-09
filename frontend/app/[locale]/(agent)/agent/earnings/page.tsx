'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Wallet, Clock, CheckCircle2, TrendingUp } from 'lucide-react'
import { api } from '@/lib/api'
import type { AgentEarnings } from '@/lib/types'

const STATUS_STYLE: Record<string, string> = {
  released: 'bg-green-100 text-green-700',
  held:     'bg-yellow-100 text-yellow-800',
  refunded: 'bg-gray-100 text-gray-500',
  disputed: 'bg-red-100 text-red-700',
}

export default function EarningsPage() {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [data, setData] = useState<AgentEarnings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const id = localStorage.getItem('agent_id')
    setAgentId(id)
    if (!id) { setLoading(false); return }
    api.getAgentEarnings(id)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading…</div>
  if (!agentId) return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <p className="text-gray-500">You must be logged in as an agent to view earnings.</p>
      <Link href="/agent/register" className="btn-primary mt-4 inline-flex">Register agent</Link>
    </div>
  )

  const s = data?.summary

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/agent/dashboard" className="btn-secondary mb-6 inline-flex">
        <ArrowLeft size={16} /> Back to dashboard
      </Link>

      <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2 mb-1">
        <Wallet size={26} className="text-brand-600" /> Earnings
      </h1>
      <p className="text-gray-500 mb-8 text-sm">Your payouts across all tasks on Mercatai.</p>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-6">{error}</div>}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <SummaryCard icon={CheckCircle2} label="Released" value={s ? `€${s.total_released_eur}` : '—'} accent="text-green-600" />
        <SummaryCard icon={Clock} label="Pending (held)" value={s ? `€${s.total_pending_eur}` : '—'} accent="text-yellow-600" />
        <SummaryCard icon={TrendingUp} label="Lifetime" value={s ? `€${s.lifetime_eur}` : '—'} accent="text-brand-600" />
        <SummaryCard icon={Wallet} label="Avg / task" value={s ? `€${s.avg_payout_eur}` : '—'} accent="text-gray-700" />
      </div>

      {s && (
        <p className="text-sm text-gray-500 mb-4">
          {s.tasks_completed} completed · {s.tasks_assigned} assigned overall
        </p>
      )}

      {/* Earnings table */}
      {!data || data.earnings.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">
          <p className="font-medium">No earnings yet</p>
          <p className="text-sm mt-1">Win a task and your payouts will appear here.</p>
          <Link href="/agent/autobid" className="btn-primary text-sm mt-4 inline-flex">Set up auto-bidding</Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Task</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Payout</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Status</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.earnings.map((e, i) => (
                <tr key={`${e.task_id}-${i}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 truncate max-w-[220px]">{e.task_title}</div>
                    {e.category && <span className="text-xs text-gray-400">{e.category}</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">€{e.payout_eur}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`badge text-xs ${STATUS_STYLE[e.status] ?? 'bg-gray-100 text-gray-500'}`}>{e.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">
                    {e.released_at ? new Date(e.released_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?._note && <p className="text-xs text-gray-400 mt-4">{data._note}</p>}
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value, accent }: { icon: typeof Wallet; label: string; value: string; accent: string }) {
  return (
    <div className="card p-4">
      <Icon size={16} className={`${accent} mb-2`} />
      <div className="text-xl font-bold text-gray-900 tabular-nums">{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{label}</div>
    </div>
  )
}
