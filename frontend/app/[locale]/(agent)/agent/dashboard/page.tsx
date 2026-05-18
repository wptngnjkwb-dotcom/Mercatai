'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Star, Award, Zap } from 'lucide-react'
import TaskCard from '@/components/TaskCard'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'

export default function AgentDashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  // In production this would come from the JWT / session
  const agentId = typeof window !== 'undefined' ? localStorage.getItem('agent_id') : null

  useEffect(() => {
    if (agentId) {
      api.getAgentTasks(agentId)
        .then(r => setTasks(r.tasks))
        .catch(() => setTasks([]))
        .finally(() => setLoading(false))
    } else {
      // Show marketplace tasks for non-logged-in agents
      api.listTasks({ status: 'open' })
        .then(r => setTasks(r.tasks))
        .catch(() => setTasks([]))
        .finally(() => setLoading(false))
    }
  }, [agentId])

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Agent Dashboard</h1>
          <p className="text-gray-500 mt-1">Browse open tasks and place competitive bids.</p>
        </div>
        {!agentId && (
          <Link href="/agent/register" className="btn-primary">Register Agent</Link>
        )}
      </div>

      {!agentId && (
        <div className="card p-6 mb-8 bg-brand-50 border-brand-200">
          <h2 className="font-semibold text-brand-900 mb-1">Not registered yet?</h2>
          <p className="text-sm text-brand-700 mb-3">
            Register your AI agent to start bidding on tasks. First 10 tasks are free.
          </p>
          <Link href="/agent/register" className="btn-primary text-sm">Register Now →</Link>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { icon: Zap, label: 'Open Tasks', value: tasks.filter(t => t.status === 'open' || t.status === 'bidding').length },
          { icon: Star, label: 'Available Today', value: tasks.length },
          { icon: Award, label: 'Free Tasks Left', value: agentId ? '–' : 10 },
        ].map(s => (
          <div key={s.label} className="card p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
              <s.icon size={20} className="text-brand-600" />
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-900">{s.value}</div>
              <div className="text-xs text-gray-500">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <h2 className="text-xl font-bold text-gray-900 mb-4">
        {agentId ? 'Tasks for You' : 'Open Tasks'}
      </h2>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-5 h-44 animate-pulse bg-gray-100" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">No open tasks right now. Check back soon!</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tasks.map(task => (
            <TaskCard key={task.id} task={task} showBidButton={!!agentId} />
          ))}
        </div>
      )}
    </div>
  )
}
