'use client'

import { useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { Star, Clock, Euro, Award, FileText, ChevronDown, ChevronUp } from 'lucide-react'
import BadgeList from './BadgeList'
import MercataiScore from './MercataiScore'
import type { Bid } from '@/lib/types'

interface Props {
  bid: Bid
  onAccept?: (id: string) => void
  onReject?: (id: string) => void
  isOwner?: boolean
}

function TierBadge({ tier }: { tier?: number }) {
  const labels = ['', 'Basic', 'Standard', 'Pro', 'Elite']
  const colors = ['', 'bg-gray-100 text-gray-600', 'bg-blue-100 text-blue-700', 'bg-purple-100 text-purple-700', 'bg-yellow-100 text-yellow-700']
  if (!tier) return null
  return <span className={clsx('badge', colors[tier])}>{labels[tier]}</span>
}

export default function BidCard({ bid, onAccept, onReject, isOwner }: Props) {
  const score = bid.score ? Math.round(bid.score * 100) : null
  const [previewOpen, setPreviewOpen] = useState(false)

  return (
    <div className={clsx(
      'card p-5 flex flex-col gap-3',
      bid.status === 'accepted' && 'ring-2 ring-brand-500',
      bid.status === 'rejected' && 'opacity-50',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <Link href={`/agents/${bid.agent_id}`} className="font-semibold text-gray-900 hover:text-brand-700 transition-colors">
              {bid.agent_display_name ?? bid.agent_id.slice(0, 12)}
            </Link>
            <TierBadge tier={bid.agent_tier} />
            {bid.status === 'accepted' && (
              <span className="badge bg-brand-100 text-brand-700">Accepted</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {bid.agent_avg_rating !== undefined && bid.agent_avg_rating !== null && bid.agent_review_count !== undefined && bid.agent_review_count > 0 ? (
              <span className="flex items-center gap-1">
                <Star size={11} className="text-yellow-400 fill-yellow-400" />
                <span className="font-medium text-gray-700">{bid.agent_avg_rating.toFixed(1)}</span>
                <span className="text-gray-400">({bid.agent_review_count})</span>
              </span>
            ) : bid.agent_reputation_score !== undefined && (
              <span className="flex items-center gap-1">
                <Star size={11} className="text-yellow-400 fill-yellow-400" />
                {bid.agent_reputation_score.toFixed(1)}
              </span>
            )}
            {bid.agent_total_tasks_completed !== undefined && (
              <span className="flex items-center gap-1">
                <Award size={11} /> {bid.agent_total_tasks_completed} tasks
              </span>
            )}
            {bid.agent_success_rate !== undefined && (
              <span>{(bid.agent_success_rate * 100).toFixed(0)}% success</span>
            )}
          </div>
          {bid.agent_badges && bid.agent_badges.length > 0 && (
            <div className="mt-2">
              <BadgeList badges={bid.agent_badges} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {bid.agent_mercatai_score && (
            <MercataiScore score={bid.agent_mercatai_score} size="sm" />
          )}
          <div className="text-right">
            <div className="text-xl font-bold text-gray-900">€{bid.price_eur}</div>
            {score !== null && (
              <div className="text-xs text-gray-400">Match: {score}/100</div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <Clock size={12} /> {bid.delivery_hours}h delivery
        </span>
      </div>

      {bid.approach_summary && (
        <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3 leading-relaxed">
          {bid.approach_summary}
        </p>
      )}

      {bid.sample_preview && (
        <div className="border border-brand-200 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setPreviewOpen(o => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-brand-50 hover:bg-brand-100 text-sm font-medium text-brand-700 transition-colors"
          >
            <span className="flex items-center gap-2">
              <FileText size={14} />
              Sample preview
            </span>
            {previewOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {previewOpen && (
            <pre className="text-sm text-gray-700 bg-white p-3 leading-relaxed whitespace-pre-wrap font-sans">
              {bid.sample_preview}
            </pre>
          )}
        </div>
      )}

      {isOwner && bid.status === 'pending' && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onAccept?.(bid.id)}
            className="btn-primary flex-1 justify-center"
          >
            Accept & Proceed to Payment
          </button>
          <button
            onClick={() => onReject?.(bid.id)}
            className="btn-secondary px-3"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  )
}
