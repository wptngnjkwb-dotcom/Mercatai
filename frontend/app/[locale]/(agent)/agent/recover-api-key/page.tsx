'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

export default function AgentApiKeyRecoveryPage() {
  const t = useTranslations('agentAccess')
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const [agentId, setAgentId] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [replacement, setReplacement] = useState<{ agent_id: string; api_key: string } | null>(null)

  async function requestRecovery(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/v1/auth/agent-key-recovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId.trim(), email: email.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || t('recoveryError'))
      setMessage(t('recoveryRequested'))
    } catch (error) {
      setError(error instanceof Error ? error.message : t('recoveryError'))
    } finally { setBusy(false) }
  }

  async function confirmRecovery() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/v1/auth/agent-key-recovery/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || t('recoveryError'))
      setReplacement({ agent_id: body.agent_id, api_key: body.api_key })
    } catch (error) {
      setError(error instanceof Error ? error.message : t('recoveryError'))
    } finally { setBusy(false) }
  }

  if (replacement) return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold mb-3">{t('replacementTitle')}</h1>
      <p className="text-gray-600 mb-5">{t('replacementBody')}</p>
      <div className="card p-5 space-y-3">
        <p className="text-sm"><strong>{t('agentId')}:</strong> <code>{replacement.agent_id}</code></p>
        <code className="block break-all select-all bg-amber-50 border border-amber-300 rounded p-3 text-xs">{replacement.api_key}</code>
        <p className="text-xs text-amber-700">{t('saveReplacement')}</p>
        <p className="text-xs text-gray-600">{t('securityReset')}</p>
      </div>
      <Link href="/agent/login" className="btn-primary inline-flex mt-6">{t('continueLogin')}</Link>
    </div>
  )

  return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">{token ? t('confirmTitle') : t('recoveryTitle')}</h1>
      <p className="text-gray-500 mb-8">{token ? t('confirmBody') : t('recoveryBody')}</p>
      {token ? (
        <div className="card p-6 space-y-4"><button onClick={confirmRecovery} className="btn-primary w-full justify-center" disabled={busy}>{busy ? t('rotating') : t('rotateKey')}</button></div>
      ) : (
        <form onSubmit={requestRecovery} className="card p-6 space-y-5">
          <div><label className="label">{t('agentId')}</label><input className="input" required value={agentId} onChange={(e) => setAgentId(e.target.value)} /></div>
          <div><label className="label">{t('ownerEmail')}</label><input className="input" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? t('sending') : t('sendRecovery')}</button>
        </form>
      )}
      {message && <p className="mt-4 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </div>
  )
}
