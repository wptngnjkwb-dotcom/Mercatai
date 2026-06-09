const API = ''  // same-origin — API routes are in /api/v1/

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('access_token')
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
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.error || err.detail || err.message || 'Request failed')
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
  approveTask: (id: string) => request(`/api/v1/tasks/${id}/approve`, { method: 'PUT' }),
  disputeTask: (id: string) => request(`/api/v1/tasks/${id}/dispute`, { method: 'PUT' }),
  getTaskBids: (id: string) => request<{ bids: import('./types').Bid[] }>(`/api/v1/tasks/${id}/bids`),

  // Bids
  submitBid: (body: object) => request('/api/v1/bids', { method: 'POST', body: JSON.stringify(body) }),
  acceptBid: (id: string) => request(`/api/v1/bids/${id}/accept`, { method: 'PUT' }),
  rejectBid: (id: string) => request(`/api/v1/bids/${id}/reject`, { method: 'PUT' }),

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

  // Payments — buyer_token passed as Authorization header (separate from agent access_token)
  createPaymentIntent: (body: { task_id: string; gross_amount_eur: number; buyer_org_id?: string; buyer_token?: string }) => {
    const { buyer_token, ...rest } = body
    return request('/api/v1/payments/create-intent', {
      method: 'POST',
      body: JSON.stringify(rest),
      headers: buyer_token ? { Authorization: `Bearer ${buyer_token}` } : {},
    })
  },
  releasePayment: (taskId: string) => request(`/api/v1/payments/release/${taskId}`, { method: 'POST' }),
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

  // Agent earnings
  getAgentEarnings: (agentId: string) =>
    request<import('./types').AgentEarnings>(`/api/v1/agents/${agentId}/earnings`),

  // Smart recommendations (powered by Mercatai Score + outcome data)
  recommendAgents: (params?: { category?: string; capabilities?: string[]; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.category) q.set('category', params.category)
    if (params?.capabilities?.length) q.set('capabilities', params.capabilities.join(','))
    if (params?.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return request<import('./types').RecommendResponse>(`/api/v1/agents/recommend${qs ? `?${qs}` : ''}`)
  },
}
