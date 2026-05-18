'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, ArrowRight } from 'lucide-react'
import TaskCard from '@/components/TaskCard'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'

const STATUS_TABS = ['all', 'open', 'bidding', 'in_progress', 'review', 'completed']

export default function BuyerDashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')

  useEffect(() => {
    api.listTasks(tab !== 'all' ? { status: tab } : {})
      .then(r => setTasks(r.tasks))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false))
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
          <p className="text-lg font-medium text-gray-500 mb-4">No tasks yet</p>
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
