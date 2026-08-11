'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, ArrowRight } from 'lucide-react'
import TaskCard from '@/components/TaskCard'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'

const STATUS_TABS = ['all', 'open', 'bidding', 'in_progress', 'review', 'completed']

/**
 * Tasks a buyer owns are exactly the ones this browser holds a buyer token
 * for — there are no buyer accounts, the task-bound token *is* the
 * credential. Listing every public task here would claim ownership of
 * other people's work.
 */
function ownedTaskIds(): string[] {
  if (typeof window === 'undefined') return []
  return Object.keys(localStorage)
    .filter(k => k.startsWith('buyer_token_'))
    .map(k => k.slice('buyer_token_'.length))
    .filter(Boolean)
}

export default function BuyerDashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [paymentNotice, setPaymentNotice] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const returnedTaskId = params.get('task_id')
    const directState = params.get('payment')

    if (directState === 'authorized') {
      setPaymentNotice('Card authorized. Work can start; capture happens after you approve the delivery.')
    } else if (directState === 'processing') {
      setPaymentNotice('SEPA debit submitted. Work starts after Stripe confirms settlement.')
    }

    if (!returnedTaskId || params.get('payment_return') !== '1') return
    const buyerToken = localStorage.getItem(`buyer_token_${returnedTaskId}`)
    if (!buyerToken) {
      setPaymentNotice('Payment returned from Stripe, but this browser has no buyer token to verify it.')
      return
    }

    fetch(`/api/v1/payments/status/${returnedTaskId}`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
      cache: 'no-store',
    })
      .then(async response => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Payment verification failed')
        setPaymentNotice(body.payment_state === 'processing'
          ? 'SEPA debit submitted. Work starts after Stripe confirms settlement.'
          : body.payment_state === 'authorized'
            ? 'Payment authorized. Work can start.'
            : 'Payment still needs confirmation. Open the task to finish payment.')
      })
      .catch(error => setPaymentNotice(error instanceof Error ? error.message : 'Payment verification failed'))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const ids = ownedTaskIds()
    if (ids.length === 0) {
      setTasks([])
      setLoading(false)
      return
    }

    Promise.all(ids.map(id => api.getTask(id).catch(() => null)))
      .then(results => {
        if (cancelled) return
        const owned = results.filter((t): t is Task => t !== null)
        setTasks(tab === 'all' ? owned : owned.filter(t => t.status === tab))
      })
      .catch(() => { if (!cancelled) setTasks([]) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [tab])

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Buyer Dashboard</h1>
          <p className="text-gray-500 mt-1">Manage your tasks and review bids.</p>
        </div>
        <Link href="/buyer/tasks/new" className="btn-primary">
          <Plus size={16} /> Post New Task
        </Link>
      </div>

      {/* Tabs */}
      {paymentNotice && (
        <div role="status" className="mb-5 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {paymentNotice}
        </div>
      )}

      <div className="flex gap-1 mb-6 overflow-x-auto">
        {STATUS_TABS.map(s => (
          <button
            key={s}
            onClick={() => setTab(s)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === s
                ? 'bg-brand-600 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {s === 'all' ? 'All Tasks' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-5 h-44 animate-pulse bg-gray-100" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-lg font-medium text-gray-500 mb-2">No tasks yet</p>
          <p className="text-sm text-gray-400 mb-4 max-w-md mx-auto">
            Tasks are tracked by the buyer token saved in this browser. If you
            posted a task from another browser or device, open it with the
            buyer token you were given at creation.
          </p>
          <Link href="/buyer/tasks/new" className="btn-primary">
            Post your first task <ArrowRight size={16} />
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tasks.map(task => (
            <div key={task.id} className="relative">
              <TaskCard task={task} />
              {(task.status === 'bidding' || task.status === 'open') && task.bid_count > 0 && (
                <Link
                  href={`/buyer/tasks/${task.id}/bids`}
                  className="absolute top-4 right-4 btn-primary text-xs py-1"
                >
                  View {task.bid_count} bid{task.bid_count !== 1 ? 's' : ''} <ArrowRight size={12} />
                </Link>
              )}
              {task.status === 'assigned' && (
                <Link
                  href={`/buyer/tasks/${task.id}/bids`}
                  className="absolute top-4 right-4 btn-primary text-xs py-1"
                >
                  Complete payment <ArrowRight size={12} />
                </Link>
              )}
              {task.status === 'review' && (
                <Link
                  href={`/buyer/tasks/${task.id}/bids`}
                  className="absolute top-4 right-4 btn bg-purple-600 text-white text-xs py-1"
                >
                  Review Delivery <ArrowRight size={12} />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
