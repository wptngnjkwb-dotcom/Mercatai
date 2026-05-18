'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, CheckCircle, AlertTriangle } from 'lucide-react'
import BidCard from '@/components/BidCard'
import { api } from '@/lib/api'
import type { Task, Bid } from '@/lib/types'

export default function TaskBidsPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [task, setTask] = useState<Task | null>(null)
  const [bids, setBids] = useState<Bid[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.getTask(id), api.getTaskBids(id)])
      .then(([t, b]) => { setTask(t); setBids(b.bids) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  const handleAccept = async (bidId: string) => {
    if (!confirm('Accept this bid? All other bids will be rejected.')) return
    setAction(bidId)
    try {
      await api.acceptBid(bidId)
      router.push('/buyer/dashboard')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

  const handleReject = async (bidId: string) => {
    setAction(bidId)
    try {
      await api.rejectBid(bidId)
      setBids(prev => prev.map(b => b.id === bidId ? { ...b, status: 'rejected' } : b))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

  const handleApproveTask = async () => {
    if (!confirm('Approve delivery and release escrow payment to the agent?')) return
    try {
      await api.approveTask(id)
      await api.releasePayment(id)
      router.push('/buyer/dashboard')
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading...</div>

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/buyer/dashboard" className="btn-secondary mb-6 inline-flex">
        <ArrowLeft size={16} /> Back to Dashboard
      </Link>

      {task && (
        <div className="card p-5 mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">{task.title}</h1>
              <p className="text-sm text-gray-500">
                Budget €{task.budget_min_eur}–{task.budget_max_eur} · {task.deadline_hours}h deadline
              </p>
            </div>
            <span className={`badge ${task.status === 'review' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
              {task.status.replace('_', ' ')}
            </span>
          </div>

          {task.status === 'review' && (
            <div className="mt-4 flex gap-3">
              <button onClick={handleApproveTask} className="btn-primary flex-1 justify-center">
                <CheckCircle size={16} /> Approve Delivery & Release Payment
              </button>
              <button onClick={() => api.disputeTask(id)} className="btn-danger">
                <AlertTriangle size={16} /> Dispute
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-6">
          {error}
        </div>
      )}

      <h2 className="text-xl font-bold text-gray-900 mb-4">
        {bids.length} Bid{bids.length !== 1 ? 's' : ''} — ranked by score
      </h2>

      {bids.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">No bids yet. Check back after the bidding window closes.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {bids.map(bid => (
            <BidCard
              key={bid.id}
              bid={bid}
              isOwner={task?.status === 'bidding' || task?.status === 'open'}
              onAccept={action ? undefined : handleAccept}
              onReject={action ? undefined : handleReject}
            />
          ))}
        </div>
      )}
    </div>
  )
}
