'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, CheckCircle, AlertTriangle, Lock, Star } from 'lucide-react'
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

  // Payment step after bid acceptance
  const [pendingPayment, setPendingPayment] = useState<{ bidId: string; priceEur: number; agentName: string } | null>(null)
  const [buyerToken, setBuyerToken] = useState('')
  const [payLoading, setPayLoading] = useState(false)
  const [payError, setPayError] = useState('')

  // Review step after task approval
  const [pendingReview, setPendingReview] = useState<{ agentName: string } | null>(null)
  const [reviewRating, setReviewRating] = useState(0)
  const [reviewText, setReviewText] = useState('')
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')

  useEffect(() => {
    Promise.all([api.getTask(id), api.getTaskBids(id)])
      .then(([t, b]) => { setTask(t); setBids(b.bids) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // Pre-fill buyer_token from localStorage if saved at task creation
    const saved = localStorage.getItem(`buyer_token_${id}`)
    if (saved) setBuyerToken(saved)
  }, [id])

  const handleAccept = async (bidId: string) => {
    if (!confirm('Accept this bid? All other bids will be rejected.')) return
    setAction(bidId)
    try {
      await api.acceptBid(bidId)
      const acceptedBid = bids.find(b => b.id === bidId)
      // Show payment step instead of redirecting
      setPendingPayment({
        bidId,
        priceEur: acceptedBid?.price_eur ?? 0,
        agentName: (acceptedBid as any)?.agent_name ?? 'Agent',
      })
      setBids(prev => prev.map(b => b.id === bidId ? { ...b, status: 'accepted' } : { ...b, status: 'rejected' }))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

  const handlePayEscrow = async () => {
    if (!pendingPayment || !buyerToken) return
    setPayLoading(true)
    setPayError('')
    try {
      await api.createPaymentIntent({
        task_id: id,
        gross_amount_eur: pendingPayment.priceEur,
        buyer_org_id: task?.posted_by_org_id,
        buyer_token: buyerToken,
      })
      router.push('/buyer/dashboard?paid=1')
    } catch (e: any) {
      setPayError(e.message ?? 'Payment failed')
    } finally {
      setPayLoading(false)
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
    if (!confirm('Approve delivery and release payment to the agent?')) return
    try {
      await api.approveTask(id)
      const acceptedBid = bids.find(b => b.status === 'accepted')
      setPendingReview({ agentName: acceptedBid?.agent_display_name ?? 'the agent' })
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleSubmitReview = async () => {
    if (!reviewRating || !buyerToken) return
    setReviewLoading(true)
    setReviewError('')
    try {
      await api.submitReview({
        task_id: id,
        rating: reviewRating,
        text: reviewText || undefined,
        buyer_token: buyerToken,
      })
      router.push('/buyer/dashboard?reviewed=1')
    } catch (e: any) {
      setReviewError(e.message ?? 'Failed to submit review')
    } finally {
      setReviewLoading(false)
    }
  }

  const handleSkipReview = () => {
    router.push('/buyer/dashboard')
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading...</div>

  // Review step overlay after task approval
  if (pendingReview) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 bg-yellow-50 rounded-full mx-auto flex items-center justify-center">
            <Star className="text-yellow-500 fill-yellow-400" size={28} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Rate the delivery</h1>
          <p className="text-gray-500 text-sm">
            Your payment has been released to <strong>{pendingReview.agentName}</strong>. Your honest review
            helps other buyers choose the right agent.
          </p>
        </div>

        <div className="flex justify-center gap-2">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => setReviewRating(n)}
              className="p-1 transition-transform hover:scale-110"
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
            >
              <Star
                size={36}
                className={n <= reviewRating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
              />
            </button>
          ))}
        </div>

        <textarea
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 h-24 resize-none"
          placeholder="Optional — what went well? Anything to improve? (max 2000 chars)"
          maxLength={2000}
          value={reviewText}
          onChange={e => setReviewText(e.target.value)}
        />

        {!buyerToken && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Your buyer token</label>
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 h-20 resize-none"
              placeholder="Paste your buyer token (eyJ...)"
              value={buyerToken}
              onChange={e => setBuyerToken(e.target.value)}
            />
          </div>
        )}

        {reviewError && <p className="text-sm text-red-600">{reviewError}</p>}

        <div className="flex gap-2">
          <button
            onClick={handleSubmitReview}
            disabled={!reviewRating || !buyerToken || reviewLoading}
            className="flex-1 bg-brand-600 text-white rounded-xl py-3 font-semibold hover:bg-brand-700 disabled:opacity-50 transition"
          >
            {reviewLoading ? 'Submitting…' : 'Submit review'}
          </button>
          <button
            onClick={handleSkipReview}
            className="px-4 py-3 text-sm text-gray-500 hover:text-gray-700"
          >
            Skip
          </button>
        </div>
      </div>
    )
  }

  // Payment step overlay after bid acceptance
  if (pendingPayment) {
    const fee = Math.round(pendingPayment.priceEur * 0.05 * 100) / 100
    return (
      <div className="max-w-md mx-auto px-4 py-16 space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 bg-brand-50 rounded-full mx-auto flex items-center justify-center">
            <Lock className="text-brand-600" size={28} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Authorize payment</h1>
          <p className="text-gray-500 text-sm">
            Bid accepted from <strong>{pendingPayment.agentName}</strong>. Payment is securely
            authorized via Stripe and released only after you approve the delivery.
          </p>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Task price</span><span className="font-medium">€{pendingPayment.priceEur}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Platform fee (5%)</span><span className="font-medium">€{fee}</span></div>
          <div className="flex justify-between border-t border-gray-200 pt-2 mt-2"><span className="font-semibold">Total</span><span className="font-bold text-brand-700">€{(pendingPayment.priceEur + fee).toFixed(2)}</span></div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">Your buyer token</label>
          <textarea
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 h-20 resize-none"
            placeholder="Paste your buyer token (eyJ...)"
            value={buyerToken}
            onChange={e => setBuyerToken(e.target.value)}
          />
          <p className="text-xs text-gray-400">You received this token when you posted the task. Check your email or the task creation page.</p>
        </div>

        {payError && <p className="text-sm text-red-600">{payError}</p>}

        <button
          onClick={handlePayEscrow}
          disabled={!buyerToken || payLoading}
          className="w-full bg-brand-600 text-white rounded-xl py-3 font-semibold hover:bg-brand-700 disabled:opacity-50 transition"
        >
          {payLoading ? 'Processing…' : `Authorize €${(pendingPayment.priceEur + fee).toFixed(2)} payment`}
        </button>
        <p className="text-xs text-center text-gray-400">
          Secured by Stripe · SEPA &amp; card · Released only after your approval
        </p>
      </div>
    )
  }

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
                <CheckCircle size={16} /> Approve Delivery &amp; Release Payment
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
