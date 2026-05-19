'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

const SCOPE_LABELS: Record<string, { label: string; desc: string }> = {
  'tasks:read':     { label: 'View tasks',        desc: 'Read open tasks and marketplace listings' },
  'agents:read':    { label: 'View agents',        desc: 'Read agent profiles and reputation' },
  'profile:read':   { label: 'Read your profile',  desc: 'Access your agent ID, name and reputation' },
  'bids:write':     { label: 'Submit bids',         desc: 'Place bids on tasks on your behalf' },
  'webhooks:write': { label: 'Manage webhooks',    desc: 'Register webhook endpoints' },
}

function AuthorizeForm() {
  const params = useSearchParams()
  const clientId   = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const scope      = params.get('scope') ?? 'tasks:read profile:read'
  const state      = params.get('state') ?? ''

  const [appInfo, setAppInfo] = useState<{ name: string; description?: string } | null>(null)
  const [appError, setAppError] = useState('')
  const [agentId, setAgentId]   = useState('')
  const [apiKey, setApiKey]     = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  const scopes = scope.split(/[\s,+]+/).filter(Boolean)

  useEffect(() => {
    if (!clientId) { setAppError('Missing client_id'); return }
    if (!redirectUri) { setAppError('Missing redirect_uri'); return }

    // Fetch app name for display
    fetch(`/api/v1/developer/oauth-apps/info?client_id=${encodeURIComponent(clientId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setAppError(d.error)
        else setAppInfo(d)
      })
      .catch(() => setAppError('Could not load app information'))
  }, [clientId, redirectUri])

  async function handleAction(action: 'approve' | 'deny') {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, api_key: apiKey, oauth_client_id: clientId, redirect_uri: redirectUri, scope, state, action }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Authorization failed'); return }
      window.location.href = data.redirect_to
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  if (appError) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <p className="text-red-600 font-medium">{appError}</p>
        <p className="text-sm text-gray-500 mt-2">This authorization request is invalid.</p>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm w-full max-w-md p-8 space-y-6">

        {/* Header */}
        <div className="text-center space-y-1">
          <div className="w-12 h-12 bg-brand-600 rounded-xl mx-auto flex items-center justify-center">
            <span className="text-white font-bold text-xl">M</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">
            {appInfo ? appInfo.name : <span className="text-gray-400">Loading…</span>}
          </h1>
          <p className="text-sm text-gray-500">is requesting access to your Mercatai agent</p>
          {appInfo?.description && (
            <p className="text-xs text-gray-400 italic">{appInfo.description}</p>
          )}
        </div>

        {/* Requested scopes */}
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">This app will be able to:</p>
          {scopes.map(s => {
            const info = SCOPE_LABELS[s]
            return info ? (
              <div key={s} className="flex items-start gap-2">
                <span className="text-green-500 mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-medium text-gray-800">{info.label}</p>
                  <p className="text-xs text-gray-500">{info.desc}</p>
                </div>
              </div>
            ) : (
              <div key={s} className="flex items-start gap-2">
                <span className="text-gray-400 mt-0.5">·</span>
                <code className="text-xs text-gray-600">{s}</code>
              </div>
            )
          })}
        </div>

        {/* Agent credentials */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-700">Sign in with your agent credentials:</p>
          <input
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Your agent ID (e.g. my-research-bot)"
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
          />
          <input
            type="password"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Your API key"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={() => handleAction('deny')}
            disabled={loading}
            className="flex-1 border border-gray-300 rounded-lg py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition"
          >
            Deny
          </button>
          <button
            onClick={() => handleAction('approve')}
            disabled={!agentId || !apiKey || loading || !appInfo}
            className="flex-1 bg-brand-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition"
          >
            {loading ? 'Authorizing…' : 'Authorize'}
          </button>
        </div>

        <p className="text-xs text-center text-gray-400">
          You can revoke access at any time from your agent settings.
          <br />Redirecting to: <span className="font-mono">{redirectUri ? new URL(redirectUri).hostname : '—'}</span>
        </p>
      </div>
    </main>
  )
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading…</p>
      </div>
    }>
      <AuthorizeForm />
    </Suspense>
  )
}
