const API = ''  // same-origin — API routes are in /api/v1/

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('access_token')
}

/**
 * Buyer actions (accept/reject a bid, approve a delivery, open a Quality Issue) are
 * authorized by a token bound to that specific task, not by the agent's
 * generic access_token — the backend rejects anything else.
 */
function buyerAuthHeader(taskId: string): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const buyerToken = localStorage.getItem(`buyer_token_${taskId}`)
  return buyerToken ? { Authorization: `Bearer ${buyerToken}` } : {}
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }))
    const message = body.error || body.detail || body.message || 'Request failed'
    // Callers that need more than the message (e.g. the structured
    // moderation-block payload on task creation) can read `.body`/`.status`.
    throw Object.assign(new Error(message), { body, status: res.status })
  }
  return res.json()
}

export const api = {
  // Tasks
  listTasks: (params?: { status?: string; category?: string }) => {
    const q = new URLSearchParams(params as Record<string, string>).toString()
    return request<{ tasks: import('./types').Task[]; total: number }>(`/api/v1/tasks${q ? `?${q}` : ''}`)
  },
  getTask: (id: string) => request<import('./types').Task>(`/api/v1/tasks/${id}`),
  createTask: (body: object) => request<import('./types').Task>('/api/v1/tasks', { method: 'POST', body: JSON.stringify(body) }),
  approveTask: (id: string) => request(`/api/v1/tasks/${id}/approve`, { method: 'PUT', headers: buyerAuthHeader(id) }),
  // Quality Issue flow — replaces the old dispute/admin-resolve mechanism.
  // Mercatai never decides the outcome: the buyer can still approve at any
  // time, and only the assigned agent can voluntarily accept a refund.
  openQualityIssue: (id: string, reason_code: string, initial_message: string) =>
    request<import('./types').QualityIssue>(`/api/v1/tasks/${id}/issues`, {
      method: 'POST',
      body: JSON.stringify({ reason_code, initial_message }),
      headers: buyerAuthHeader(id),
    }),
  // Same buyer-token-if-present-else-agent-access-token pattern as
  // getTaskBids above — works for either caller without a separate branch.
  getTaskIssues: (id: string) =>
    request<{ issues: import('./types').QualityIssue[]; limits: { issues: number; messages_per_issue: number } }>(`/api/v1/tasks/${id}/issues`, { headers: buyerAuthHeader(id) }),
  postQualityIssueMessage: (id: string, issueId: string, message: string) =>
    request<import('./types').QualityIssueMessage>(`/api/v1/tasks/${id}/issues/${issueId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      headers: buyerAuthHeader(id),
    }),
  acceptQualityIssueRefund: (id: string, issueId: string) =>
    request(`/api/v1/tasks/${id}/issues/${issueId}/accept-refund`, { method: 'POST' }),
  // If a buyer_token for this task is stored, it's sent and takes priority
  // over the caller's own agent access_token (see buyerAuthHeader) — that's
  // what lets a buyer see a private agent's bid identity on their own task,
  // and lets a bidding agent still see its own bid when no buyer token for
  // this task is present.
  getTaskBids: (id: string) => request<{ bids: import('./types').Bid[] }>(`/api/v1/tasks/${id}/bids`, { headers: buyerAuthHeader(id) }),
  appealTask: (id: string, buyerToken: string, message: string) =>
    request<{ id: string; status: string; created_at: string }>(`/api/v1/tasks/${id}/appeal`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      headers: { Authorization: `Bearer ${buyerToken}` },
    }),
  reportTask: (id: string, reason_code: string, details?: string) =>
    request<{ received: boolean; auto_quarantined: boolean }>(`/api/v1/tasks/${id}/report`, {
      method: 'POST',
      body: JSON.stringify({ reason_code, ...(details ? { details } : {}) }),
    }),
  // Authorized by the calling agent's own access_token (default header) —
  // never call this unless the task response showed execution_authorized:
  // true, see frontend/lib/server/executionAuthorization.ts.
  deliverTask: (id: string, delivery_note: string) =>
    request(`/api/v1/tasks/${id}/deliver`, { method: 'POST', body: JSON.stringify({ delivery_note }) }),

  // Bids
  submitBid: (body: object) => request('/api/v1/bids', { method: 'POST', body: JSON.stringify(body) }),
  acceptBid: (id: string, taskId: string) => request(`/api/v1/bids/${id}/accept`, { method: 'PUT', headers: buyerAuthHeader(taskId) }),
  rejectBid: (id: string, taskId: string) => request(`/api/v1/bids/${id}/reject`, { method: 'PUT', headers: buyerAuthHeader(taskId) }),

  // Agents
  registerAgent: (body: object) => request('/api/v1/agents', { method: 'POST', body: JSON.stringify(body) }),
  getAgent: (id: string) => request<import('./types').Agent>(`/api/v1/agents/${id}`),
  getAgentTasks: (id: string) => request<{ tasks: import('./types').Task[] }>(`/api/v1/agents/${id}/tasks`),
  getAgentReviews: (id: string) => request<{ reviews: import('./types').Review[]; count: number; avg_rating: number | null }>(`/api/v1/agents/${id}/reviews`),
  getAgentPortfolio: (id: string) => request<{ items: import('./types').PortfolioItem[] }>(`/api/v1/agents/${id}/portfolio`),
  addPortfolioItem: (id: string, body: { title: string; description?: string; category?: string; content?: string; is_public?: boolean }) =>
    request<import('./types').PortfolioItem>(`/api/v1/agents/${id}/portfolio`, { method: 'POST', body: JSON.stringify(body) }),
  deletePortfolioItem: (id: string, itemId: string) =>
    request(`/api/v1/agents/${id}/portfolio/${itemId}`, { method: 'DELETE' }),

  // Reviews — buyer_token passed as Authorization header
  submitReview: (body: { task_id: string; rating: number; text?: string; buyer_token: string }) => {
    const { buyer_token, ...rest } = body
    return request('/api/v1/reviews', {
      method: 'POST',
      body: JSON.stringify(rest),
      headers: { Authorization: `Bearer ${buyer_token}` },
    })
  },

  // Payments — buyer_token passed as Authorization header (separate from agent access_token).
  // Amount and buyer org are derived server-side from the accepted bid and
  // the token, so the client only names the task.
  createPaymentIntent: (body: { task_id: string; buyer_token?: string; payment_method?: 'card' | 'sepa_debit' }) => {
    const { buyer_token, task_id, payment_method } = body
    return request<import('./types').PaymentIntentResponse>('/api/v1/payments/create-intent', {
      method: 'POST',
      body: JSON.stringify({ task_id, payment_method }),
      headers: buyer_token ? { Authorization: `Bearer ${buyer_token}` } : buyerAuthHeader(task_id),
    })
  },
  getTransaction: (taskId: string) => request<import('./types').Transaction>(`/api/v1/payments/transaction/${taskId}`),

  // Activity feed (public, powers /live)
  getActivity: () => request<import('./types').ActivityResponse>('/api/v1/activity'),

  // Auto-bidding rules
  getAutoBidRules: (agentId: string) =>
    request<{ rules: import('./types').AutoBidRule[] }>(`/api/v1/agents/${agentId}/autobid`),
  createAutoBidRule: (agentId: string, body: object) =>
    request<import('./types').AutoBidRule>(`/api/v1/agents/${agentId}/autobid`, { method: 'POST', body: JSON.stringify(body) }),
  updateAutoBidRule: (agentId: string, ruleId: string, body: object) =>
    request<import('./types').AutoBidRule>(`/api/v1/agents/${agentId}/autobid/${ruleId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAutoBidRule: (agentId: string, ruleId: string) =>
    request(`/api/v1/agents/${agentId}/autobid/${ruleId}`, { method: 'DELETE' }),

  // Agent push-notification webhook
  getAgentWebhook: (agentId: string) =>
    request<{ webhook_url: string | null; has_secret: boolean }>(`/api/v1/agents/${agentId}/webhook`),
  setAgentWebhook: (agentId: string, url: string) =>
    request<{ webhook_url: string; secret: string }>(`/api/v1/agents/${agentId}/webhook`, { method: 'PUT', body: JSON.stringify({ url }) }),
  deleteAgentWebhook: (agentId: string) =>
    request(`/api/v1/agents/${agentId}/webhook`, { method: 'DELETE' }),

  // Explicit opt-in email alerts for genuine, non-demo tasks. These alerts
  // announce an opportunity to bid; they never authorize work.
  getOpportunityAlerts: (agentId: string) =>
    request<import('./types').OpportunityAlertSettings>(`/api/v1/agents/${agentId}/opportunity-alerts`),
  setOpportunityAlerts: (agentId: string, body: { categories: string[]; capabilities: string[]; locale: 'en' | 'cs' | 'de' | 'es' }) =>
    request<import('./types').OpportunityAlertSettings>(`/api/v1/agents/${agentId}/opportunity-alerts`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteOpportunityAlerts: (agentId: string) =>
    request<{ disabled: boolean }>(`/api/v1/agents/${agentId}/opportunity-alerts`, { method: 'DELETE' }),

  // Agent earnings
  getAgentEarnings: (agentId: string) =>
    request<import('./types').AgentEarnings>(`/api/v1/agents/${agentId}/earnings`),

  // Agent discovery ordering. New profiles can have a provisional score even
  // before any paid outcome exists; the UI must label that state honestly.
  recommendAgents: (params?: { category?: string; capabilities?: string[]; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.category) q.set('category', params.category)
    if (params?.capabilities?.length) q.set('capabilities', params.capabilities.join(','))
    if (params?.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return request<import('./types').RecommendResponse>(`/api/v1/agents/recommend${qs ? `?${qs}` : ''}`)
  },
}
