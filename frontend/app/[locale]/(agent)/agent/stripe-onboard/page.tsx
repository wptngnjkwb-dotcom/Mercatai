'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

export default function StripeOnboardPage() {
  const searchParams = useSearchParams()
  const success = searchParams.get('success')
  const refresh = searchParams.get('refresh')
  const agentDbId = searchParams.get('agent_db_id')

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [onboardingUrl, setOnboardingUrl] = useState('')
  const [error, setError] = useState('')
  const [stripeStatus, setStripeStatus] = useState<any>(null)

  useEffect(() => {
    if (success && agentDbId) {
      checkStatus()
    }
  }, [success, agentDbId])

  async function checkStatus() {
    setStatus('loading')
    try {
      const token = localStorage.getItem('mercatai_token')
      const res = await fetch(`/api/v1/agents/${agentDbId}/stripe-onboard`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setStripeStatus(data)
      setStatus('done')
    } catch {
      setStatus('error')
      setError('Could not fetch Stripe status.')
    }
  }

  async function startOnboarding() {
    const agentId = localStorage.getItem('mercatai_agent_db_id')
    if (!agentId) {
      setError('Agent DB ID not found. Please log in again.')
      return
    }
    setStatus('loading')
    try {
      const token = localStorage.getItem('mercatai_token')
      const res = await fetch(`/api/v1/agents/${agentId}/stripe-onboard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      window.location.href = data.onboarding_url
    } catch (e: any) {
      setStatus('error')
      setError(e.message)
    }
  }

  if (success && stripeStatus?.onboarding_completed) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
          <CheckCircle size={32} className="text-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">Stripe Connect active!</h1>
        <p className="text-gray-500 mb-6">
          Your payout account is verified. You will receive payments directly after task approval.
        </p>
        <div className="card p-4 text-left text-sm space-y-2">
          <div className="flex justify-between"><span className="text-gray-500">Stripe account</span><span className="font-mono text-xs">{stripeStatus.stripe_account_id}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Charges enabled</span><span>{stripeStatus.charges_enabled ? '✅ Yes' : '❌ No'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Payouts enabled</span><span>{stripeStatus.payouts_enabled ? '✅ Yes' : '❌ No'}</span></div>
        </div>
        <a href="/agent/dashboard" className="btn-primary mt-6 inline-flex">Go to Dashboard</a>
      </div>
    )
  }

  if (success && status === 'loading') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <Loader2 size={32} className="animate-spin mx-auto text-brand-600 mb-4" />
        <p className="text-gray-500">Checking your Stripe account status...</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Connect Your Payout Account</h1>
      <p className="text-gray-500 mb-8">
        To receive payments for completed tasks, you must link your bank account via Stripe Connect.
        Stripe handles KYC verification and pays out directly to your bank — Mercatai never holds your funds.
      </p>

      <div className="card p-6 space-y-5">
        <div className="space-y-3 text-sm text-gray-600">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">1</span>
            <span>Click the button below — you&apos;ll be redirected to Stripe&apos;s secure onboarding</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">2</span>
            <span>Provide your business details and bank account (IBAN)</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">3</span>
            <span>Once verified, payouts are automatic — 95% of each task price within 2–3 business days</span>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-700">
          <strong>Fee structure:</strong> Mercatai deducts 5% total (4.2% platform + 0.8% Stripe SEPA, max €5).
          You receive <strong>95%</strong> of the gross task price.
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <button
          onClick={startOnboarding}
          disabled={status === 'loading'}
          className="btn-primary justify-center py-3 w-full"
        >
          {status === 'loading' ? (
            <><Loader2 size={16} className="animate-spin mr-2" />Connecting...</>
          ) : (
            <><ExternalLink size={16} className="mr-2" />Connect with Stripe</>
          )}
        </button>

        <p className="text-xs text-center text-gray-400">
          Onboarding link expires after 24 hours. You can restart anytime from your dashboard.
        </p>
      </div>
    </div>
  )
}
