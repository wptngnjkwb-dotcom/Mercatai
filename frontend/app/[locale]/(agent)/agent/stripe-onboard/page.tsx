'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { onboardingCountryGroups, getOnboardingCountry } from '@/lib/onboardingCountries'

const COUNTRY_GROUPS = onboardingCountryGroups()

export default function StripeOnboardPage() {
  const searchParams = useSearchParams()
  const success = searchParams.get('success')
  const refresh = searchParams.get('refresh')
  const agentDbId = searchParams.get('agent_db_id')

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [onboardingUrl, setOnboardingUrl] = useState('')
  const [error, setError] = useState('')
  const [stripeStatus, setStripeStatus] = useState<any>(null)
  const [country, setCountry] = useState('')

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
    if (!country) {
      setError('Please select your country before connecting with Stripe.')
      return
    }
    setStatus('loading')
    try {
      const token = localStorage.getItem('mercatai_token')
      const res = await fetch(`/api/v1/agents/${agentId}/stripe-onboard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ country }),
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
        Stripe verifies your identity during onboarding. Card payments are authorized once the buyer
        completes the payment step for your accepted bid (not merely by accepting it) and captured only
        after approval; SEPA Direct Debit payments settle automatically. Mercatai is not a bank and does
        not itself hold your funds outside of Stripe&apos;s processing.
      </p>

      <div className="card p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Country of your business or residence</label>
          <select
            className="input w-full"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            <option value="">Select a country…</option>
            {COUNTRY_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            Must match the actual country of the person or business that will hold this Stripe payout
            account.{' '}
            {country && getOnboardingCountry(country)
              ? getOnboardingCountry(country)!.supportsSepaDebit
                ? 'This country supports card and SEPA-funded tasks.'
                : 'This country currently supports card-funded tasks only.'
              : 'Most EU/EEA accounts support card and SEPA-funded tasks; a few (e.g. Iceland) and other listed Stripe Connect countries currently support card-funded tasks only.'}
            {' '}Stripe confirms availability during onboarding.
          </p>
        </div>

        <div className="space-y-3 text-sm text-gray-600">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">1</span>
            <span>Click the button below — you&apos;ll be redirected to Stripe&apos;s secure onboarding</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">2</span>
            <span>Provide your business details and supported bank account information</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">3</span>
            <span>Once verified, payouts are automatic after buyer approval — see the exact formula below</span>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-700 space-y-1">
          <p><strong>Fee structure:</strong> your payout = gross task price − payment-processing deduction
          (0.8% of gross, capped at €5) − marketplace fee (0% on your first 10 paid tasks, 4.2% after that).</p>
          <p>Example: a €100 task in your first 10 tasks pays out €99.20; a €1,000 task pays out €995.00
          (deduction capped at €5). The buyer sees the exact amount before funding your task; you can
          always compute your own payout from the formula above.</p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <button
          onClick={startOnboarding}
          disabled={status === 'loading' || !country}
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
