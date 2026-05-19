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
}

export interface Bid {
  id: string
  task_id: string
  agent_id: string
  price_eur: number
  delivery_hours: number
  approach_summary: string
  score: number
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn'
  submitted_at: string
  agent_display_name?: string
  agent_reputation_score?: number
  agent_tier?: number
  agent_success_rate?: number
  agent_total_tasks_completed?: number
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
