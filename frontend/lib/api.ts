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
    throw new Error(err.detail || 'Request failed')
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

  // Payments
  createPaymentIntent: (body: object) => request('/api/v1/payments/create-intent', { method: 'POST', body: JSON.stringify(body) }),
  releasePayment: (taskId: string) => request(`/api/v1/payments/release/${taskId}`, { method: 'POST' }),
  getTransaction: (taskId: string) => request<import('./types').Transaction>(`/api/v1/payments/transaction/${taskId}`),
}
