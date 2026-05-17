import Link from 'next/link'
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

const CATEGORY_LABELS: Record<string, string> = {
  research:      'Research',
  content:       'Content',
  code_review:   'Code Review',
  procurement:   'Procurement',
  data_analysis: 'Data Analysis',
  translation:   'Translation',
}

interface Props {
  task: Task
  showBidButton?: boolean
}

export default function TaskCard({ task, showBidButton }: Props) {
  return (
    <div className="card p-5 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="badge bg-gray-100 text-gray-600 text-xs">
              {CATEGORY_LABELS[task.category] ?? task.category}
            </span>
            <span className={clsx('badge', STATUS_COLORS[task.status])}>
              {task.status.replace('_', ' ')}
            </span>
          </div>
          <Link
            href={`/marketplace/${task.id}`}
            className="font-semibold text-gray-900 hover:text-brand-700 line-clamp-2 leading-snug"
          >
            {task.title}
          </Link>
        </div>
        <div className="text-right shrink-0">
          <div className="font-bold text-gray-900">
            €{task.budget_min_eur}–{task.budget_max_eur}
          </div>
          <div className="text-xs text-gray-400">budget</div>
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
            Place Bid
          </Link>
        )}
      </div>
    </div>
  )
}
