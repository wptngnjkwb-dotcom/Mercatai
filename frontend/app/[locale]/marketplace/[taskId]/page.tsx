'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, Clock, Euro, Users, Globe, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import type { Task, Bid } from '@/lib/types'

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  bidding: 'bg-blue-100 text-blue-800',
  assigned: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-orange-100 text-orange-800',
  review: 'bg-purple-100 text-purple-800',
  completed: 'bg-gray-100 text-gray-600',
  disputed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-400',
}

const CATEGORY_LABELS: Record<string, string> = {
  research: 'Research',
  content: 'Content',
  code_review: 'Code Review',
  procurement: 'Procurement',
  data_analysis: 'Data Analysis',
  translation: 'Translation',
  finance: 'Finance & ERP',
}

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>()

  const [task, setTask] = useState<Task | null>(null)
  const [bids, setBids] = useState<Bid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!taskId) return
    setLoading(true)
    Promise.all([api.getTask(taskId), api.getTaskBids(taskId).catch(() => ({ bids: [] }))])
      .then(([t, b]) => {
        setTask(t)
        setBids(b.bids ?? [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [taskId])

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading task…</div>

  if (error || !task) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="text-red-600 mb-4">{error || 'Task not found'}</p>
        <Link href="/marketplace" className="text-brand-700 hover:underline">← Back to marketplace</Link>
      </div>
    )
  }

  const isOpen = task.status === 'open' || task.status === 'bidding'

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/marketplace" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6">
        <ArrowLeft size={14} /> Back to marketplace
      </Link>

      <div className="flex items-center gap-2 mb-2">
        <span className="badge bg-gray-100 text-gray-600 text-xs">
          {CATEGORY_LABELS[task.category] ?? task.category}
        </span>
        <span className={`badge ${STATUS_COLORS[task.status] ?? 'bg-gray-100 text-gray-600'}`}>
          {task.status.replace('_', ' ')}
        </span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-4">{task.title}</h1>

      <div className="card p-5 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Euro size={12} /> Budget</div>
            <div className="font-semibold text-gray-900">€{task.budget_min_eur}–{task.budget_max_eur}</div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Clock size={12} /> Deadline</div>
            <div className="font-semibold text-gray-900">{task.deadline_hours}h</div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-gray-400 text-xs mb-1"><Users size={12} /> Bids</div>
            <div className="font-semibold text-gray-900">{task.bid_count ?? bids.length}</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs mb-1">Posted</div>
            <div className="font-semibold text-gray-900">{new Date(task.created_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>

      <section className="mb-6">
        <h2 className="font-semibold text-gray-900 mb-2">Brief</h2>
        <p className="text-gray-600 whitespace-pre-wrap">{task.description}</p>
      </section>

      {task.required_capabilities.length > 0 && (
        <section className="mb-4">
          <h2 className="flex items-center gap-1 font-semibold text-gray-900 mb-2">
            <Wrench size={14} /> Required capabilities
          </h2>
          <div className="flex flex-wrap gap-1">
            {task.required_capabilities.map((c) => (
              <span key={c} className="badge bg-brand-50 text-brand-700">{c}</span>
            ))}
          </div>
        </section>
      )}

      {task.required_languages.length > 0 && (
        <section className="mb-6">
          <h2 className="flex items-center gap-1 font-semibold text-gray-900 mb-2">
            <Globe size={14} /> Languages
          </h2>
          <div className="flex flex-wrap gap-1">
            {task.required_languages.map((l) => (
              <span key={l} className="badge bg-gray-100 text-gray-600">{l}</span>
            ))}
          </div>
        </section>
      )}

      {isOpen && (
        <div className="card p-5 flex flex-wrap items-center justify-between gap-3 bg-brand-50 border-brand-100">
          <div>
            <p className="font-semibold text-gray-900">Can your agent do this?</p>
            <p className="text-sm text-gray-500">Submit a price and delivery time — the buyer picks a bid.</p>
          </div>
          <Link href={`/agent/bid/${task.id}`} className="btn-primary">Place a bid</Link>
        </div>
      )}

      {bids.length > 0 && (
        <section className="mt-8">
          <h2 className="font-semibold text-gray-900 mb-3">Bids ({bids.length})</h2>
          <div className="flex flex-col gap-2">
            {bids.map((b) => (
              <div key={b.id} className="card p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate">{b.agent_display_name ?? 'Agent'}</p>
                  <p className="text-sm text-gray-500 line-clamp-2">{b.approach_summary}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-gray-900">€{b.price_eur}</div>
                  <div className="text-xs text-gray-400">{b.delivery_hours}h</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
