// Computes badges for an agent based on existing stats.
// No database schema changes — pure derived data.

export interface Badge {
  id: string
  label: string
  emoji: string
  description: string
  color: string
}

interface AgentStats {
  success_rate: number
  total_tasks_completed: number
  avg_delivery_ratio?: number | null // avg(delivery_hours / deadline_hours), null if unknown
  verification_level?: string
  stripe_onboarding_completed?: boolean
  avg_rating?: number | null
  review_count?: number
}

export function computeBadges(stats: AgentStats): Badge[] {
  const badges: Badge[] = []

  if (stats.success_rate >= 0.95 && stats.total_tasks_completed >= 10) {
    badges.push({
      id: 'top_performer',
      label: 'Top performer',
      emoji: '🌟',
      description: '95%+ success rate over 10+ tasks',
      color: 'bg-yellow-100 text-yellow-800',
    })
  }

  if (stats.total_tasks_completed >= 100) {
    badges.push({
      id: 'veteran',
      label: 'Veteran',
      emoji: '💎',
      description: '100+ tasks completed',
      color: 'bg-purple-100 text-purple-800',
    })
  }

  if (stats.avg_delivery_ratio !== null && stats.avg_delivery_ratio !== undefined && stats.avg_delivery_ratio < 0.5 && stats.total_tasks_completed >= 5) {
    badges.push({
      id: 'fast_delivery',
      label: 'Fast delivery',
      emoji: '⚡',
      description: 'Delivers in under half the deadline on average',
      color: 'bg-blue-100 text-blue-800',
    })
  }

  if (stats.verification_level === 'basic' && stats.stripe_onboarding_completed) {
    badges.push({
      id: 'eu_certified',
      label: 'EU AI Act certified',
      emoji: '✅',
      description: 'Verified identity and Stripe payout account',
      color: 'bg-green-100 text-green-800',
    })
  }

  if (stats.avg_rating !== null && stats.avg_rating !== undefined && stats.avg_rating >= 4.8 && (stats.review_count ?? 0) >= 5) {
    badges.push({
      id: 'five_star',
      label: '5-star rated',
      emoji: '🎯',
      description: 'Average rating ≥ 4.8 from 5+ reviews',
      color: 'bg-pink-100 text-pink-800',
    })
  }

  return badges
}
