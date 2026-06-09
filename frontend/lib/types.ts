export type TaskStatus =
  | 'open' | 'bidding' | 'assigned' | 'in_progress'
  | 'review' | 'completed' | 'disputed' | 'cancelled'

export type TaskCategory =
  | 'research' | 'content' | 'code_review'
  | 'procurement' | 'data_analysis' | 'translation'

export interface Task {
  id: string
  title: string
  description: string
  category: TaskCategory
  required_capabilities: string[]
  required_languages: string[]
  budget_min_eur: number
  budget_max_eur: number
  deadline_hours: number
  status: TaskStatus
  assigned_agent_id?: string
  posted_by_org_id?: string
  bidding_closes_at?: string
  created_at: string
  bid_count: number
  buyer_token?: string   // returned only at task creation
  buyer_email?: string
  assigned_at?: string | null
  delivery_deadline_at?: string | null
}

export interface Agent {
  id: string
  agent_id: string
  display_name: string
  description: string
  capabilities: string[]
  languages: string[]
  verification_level: string
  reputation_score: number
  tier: number
  free_tasks_remaining: number
  total_tasks_completed: number
  success_rate: number
  is_active: boolean
  is_approved: boolean
  registered_at: string
  avg_rating?: number | null
  review_count?: number
  badges?: Badge[]
  mercatai_score?: MercataiScoreValue
}

export interface Badge {
  id: string
  label: string
  emoji: string
  description: string
  color: string
}

export interface ScoreComponent {
  key: string
  label: string
  points: number
  max: number
}

export interface MercataiScoreValue {
  score: number
  grade: string
  label: string
  components: ScoreComponent[]
}

export interface PortfolioItem {
  id: string
  title: string
  description?: string | null
  category?: string | null
  content?: string | null
  created_at: string
}

export interface Review {
  id: string
  task_id: string
  rating: number
  text?: string | null
  created_at: string
}

export interface Bid {
  id: string
  task_id: string
  agent_id: string
  price_eur: number
  delivery_hours: number
  approach_summary: string
  sample_preview?: string
  score: number
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn'
  submitted_at: string
  agent_display_name?: string
  agent_reputation_score?: number
  agent_tier?: number
  agent_success_rate?: number
  agent_total_tasks_completed?: number
  agent_avg_rating?: number | null
  agent_review_count?: number
  agent_badges?: Badge[]
  agent_mercatai_score?: MercataiScoreValue
}

export interface AutoBidRule {
  id: string
  agent_id: string
  label?: string | null
  category?: string | null
  capabilities: string[]
  min_budget_eur: number
  max_price_eur: number
  price_strategy: 'min' | 'mid' | 'max'
  delivery_hours: number
  proposal: string
  sample_preview?: string | null
  is_active: boolean
  max_bids_per_day: number
  created_at: string
}

export interface AgentEarnings {
  summary: {
    total_released_eur: number
    total_pending_eur: number
    lifetime_eur: number
    tasks_assigned: number
    tasks_completed: number
    avg_payout_eur: number
  }
  earnings: Array<{
    task_id: string
    task_title: string
    category: string | null
    payout_eur: number
    gross_eur: number
    status: 'held' | 'released' | 'refunded' | 'disputed'
    released_at: string | null
  }>
  _note?: string
}

export interface RecommendedAgent {
  id: string
  agent_id: string
  display_name: string
  description: string
  capabilities: string[]
  mercatai_score: MercataiScoreValue
  avg_rating: number | null
  review_count: number
  category_completed: number
}

export interface RecommendResponse {
  category: string | null
  capabilities: string[]
  recommendations: RecommendedAgent[]
}

export interface ActivityEvent {
  id: string
  type: 'bid' | 'task' | 'completed'
  title: string
  detail: string
  amount_eur?: number
  category?: string
  at: string
}

export interface ActivityResponse {
  events: ActivityEvent[]
  stats: {
    tasks_total: number
    bids_total: number
    agents_active: number
    tasks_completed: number
    gmv_eur: number
  }
  generated_at: string
}

export interface Transaction {
  id: string
  task_id: string
  gross_amount_eur: number
  platform_fee_eur: number
  stripe_fee_eur: number
  agent_payout_eur: number
  escrow_status: 'held' | 'released' | 'refunded' | 'disputed'
  review_deadline_at?: string
  released_at?: string
}
