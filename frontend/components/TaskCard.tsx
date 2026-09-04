'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import clsx from 'clsx'
import { Clock, Euro, Users } from 'lucide-react'
import type { Task } from '@/lib/types'

const STATUS_COLORS: Record<string, string> = {
  open:        'bg-green-100 text-green-800',
  bidding:     'bg-blue-100 text-blue-800',
  assigned:    'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-orange-100 text-orange-800',
  review:      'bg-purple-100 text-purple-800',
  completed:   'bg-gray-100 text-gray-600',
  disputed:    'bg-red-100 text-red-800',
  cancelled:   'bg-gray-100 text-gray-400',
}

// Deliberately distinct from STATUS_COLORS above — funding is a separate
// axis from workflow status, and 'bidding' or an accepted bid must never
// read as proof of funding.
const FUNDING_COLORS: Record<string, string> = {
  unfunded:        'bg-gray-100 text-gray-500',
  funding_pending: 'bg-amber-100 text-amber-700',
  funded:          'bg-cyan-100 text-cyan-700',
  released:        'bg-green-100 text-green-700',
  refunded:        'bg-slate-100 text-slate-600',
}

const CATEGORY_LABELS: Record<string, string> = {
  research:      'Research',
  content:       'Content',
  code_review:   'Code Review',
  procurement:   'Procurement',
  data_analysis: 'Data Analysis',
  translation:   'Translation',
  finance:       'Finance & ERP',
}

interface Props {
  task: Task
  showBidButton?: boolean
}

const COMPLETED_STATUSES = ['completed', 'cancelled']

export default function TaskCard({ task, showBidButton }: Props) {
  const t = useTranslations('taskStatus')
  const isCompleted = COMPLETED_STATUSES.includes(task.status)

  return (
    <div className={clsx('card p-5 flex flex-col gap-3 transition-shadow', isCompleted ? 'opacity-80' : 'hover:shadow-md')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="badge bg-gray-100 text-gray-600 text-xs">
              {CATEGORY_LABELS[task.category] ?? task.category}
            </span>
            <span className={clsx('badge', STATUS_COLORS[task.status])}>
              {task.status.replace('_', ' ')}
            </span>
            {task.is_demo && (
              <span className="badge bg-orange-100 text-orange-800 text-xs font-semibold">
                {t('demo.badge')}
              </span>
            )}
          </div>
          {isCompleted ? (
            <p className="font-semibold text-gray-700 line-clamp-2 leading-snug">{task.title}</p>
          ) : (
            <Link
              href={`/marketplace/${task.id}`}
              className="font-semibold text-gray-900 hover:text-brand-700 line-clamp-2 leading-snug"
            >
              {task.title}
            </Link>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-bold text-gray-900">
            €{task.budget_min_eur}–{task.budget_max_eur}
          </div>
          <span className={clsx('badge text-xs mt-1 inline-block', FUNDING_COLORS[task.funding_status])}>
            {t(`funding.${task.funding_status}`)}
          </span>
        </div>
      </div>

      <p className="text-sm text-gray-500 line-clamp-2">{task.description}</p>

      {task.required_capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {task.required_capabilities.map(c => (
            <span key={c} className="badge bg-brand-50 text-brand-700">{c}</span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 text-xs text-gray-400 pt-1 border-t border-gray-100">
        <span className="flex items-center gap-1">
          <Clock size={12} /> {task.deadline_hours}h deadline
        </span>
        <span className="flex items-center gap-1">
          <Users size={12} /> {task.bid_count} bid{task.bid_count !== 1 ? 's' : ''}
        </span>
        {task.bidding_closes_at && (
          <span className="flex items-center gap-1">
            Bidding closes {new Date(task.bidding_closes_at).toLocaleDateString()}
          </span>
        )}
        {showBidButton && (task.status === 'open' || task.status === 'bidding') && (
          <Link href={`/agent/bid/${task.id}`} className="ml-auto btn-primary py-1 text-xs">
            {task.is_demo ? t('demo.placeTestBid') : 'Place Bid'}
          </Link>
        )}
      </div>
    </div>
  )
}
