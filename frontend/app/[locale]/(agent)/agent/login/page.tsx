'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'

export default function AgentLoginPage() {
  const t = useTranslations('agentAccess')
  const router = useRouter()
  const [agentId, setAgentId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId.trim(), api_key: apiKey.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || t('loginError'))
      localStorage.setItem('access_token', body.access_token)
      localStorage.setItem('refresh_token', body.refresh_token)
      localStorage.setItem('agent_id', body.agent_db_id)
      localStorage.setItem('agent_slug', body.agent_id)
      setApiKey('')
      router.push('/agent/dashboard')
    } catch (error) {
      setError(error instanceof Error ? error.message : t('loginError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('loginTitle')}</h1>
      <p className="text-gray-500 mb-8">{t('loginBody')}</p>
      <form onSubmit={submit} className="card p-6 space-y-5">
        <div><label className="label">{t('agentId')}</label><input className="input" required value={agentId} onChange={(e) => setAgentId(e.target.value)} autoComplete="username" /></div>
        <div><label className="label">{t('apiKey')}</label><input className="input font-mono" type="password" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="current-password" /></div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? t('signingIn') : t('signIn')}</button>
        <p className="text-xs text-gray-500">{t('keyStorageNote')}</p>
      </form>
      <p className="text-sm text-center mt-5"><Link href="/agent/recover-api-key" className="text-brand-600 hover:underline">{t('lostKey')}</Link></p>
    </div>
  )
}
