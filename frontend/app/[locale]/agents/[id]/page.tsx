'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Star, Award, CheckCircle2, ArrowLeft, Calendar } from 'lucide-react'
import { api } from '@/lib/api'
import BadgeList from '@/components/BadgeList'
import type { Agent, Review } from '@/lib/types'

export default function AgentProfilePage() {
  const { id } = useParams<{ id: string }>()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [avgRating, setAvgRating] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.getAgent(id), api.getAgentReviews(id)])
      .then(([a, r]) => {
        setAgent(a)
        setReviews(r.reviews)
        setAvgRating(r.avg_rating)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading...</div>
  if (error || !agent) return <div className="max-w-3xl mx-auto px-4 py-10 text-red-600">{error || 'Agent not found'}</div>

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/marketplace" className="btn-secondary mb-6 inline-flex">
        <ArrowLeft size={16} /> Back to marketplace
      </Link>

      <div className="card p-6 mb-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{agent.display_name}</h1>
            <p className="text-sm text-gray-500 mt-1">ID: <code className="text-xs">{agent.agent_id}</code></p>
          </div>
          {agent.is_approved && (
            <span className="badge bg-green-100 text-green-700 flex items-center gap-1">
              <CheckCircle2 size={12} /> Verified
            </span>
          )}
        </div>

        <p className="text-gray-700 mb-4">{agent.description}</p>

        {agent.badges && agent.badges.length > 0 && (
          <div className="mb-4">
            <BadgeList badges={agent.badges} size="md" />
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {agent.capabilities.map(c => (
            <span key={c} className="badge bg-brand-50 text-brand-700">{c}</span>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-100">
          <Stat
            label="Rating"
            value={avgRating !== null ? avgRating.toFixed(1) : '—'}
            sub={avgRating !== null ? `${reviews.length} review${reviews.length !== 1 ? 's' : ''}` : 'No reviews yet'}
            icon={<Star size={14} className="text-yellow-400 fill-yellow-400" />}
          />
          <Stat label="Tasks completed" value={String(agent.total_tasks_completed)} icon={<Award size={14} />} />
          <Stat label="Success rate" value={`${Math.round(agent.success_rate * 100)}%`} />
          <Stat label="Reputation" value={agent.reputation_score.toFixed(1)} />
        </div>
      </div>

      <h2 className="text-xl font-bold text-gray-900 mb-4">Reviews</h2>
      {reviews.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">
          No reviews yet. Be the first buyer to work with this agent.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {reviews.map(r => (
            <div key={r.id} className="card p-5">
              <div className="flex items-center justify-between mb-2">
                <div className="flex">
                  {[1, 2, 3, 4, 5].map(n => (
                    <Star
                      key={n}
                      size={16}
                      className={n <= r.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-200'}
                    />
                  ))}
                </div>
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Calendar size={11} />
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              {r.text && <p className="text-sm text-gray-700 leading-relaxed">{r.text}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="flex items-center gap-1 font-bold text-gray-900">
        {icon} {value}
      </div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}
