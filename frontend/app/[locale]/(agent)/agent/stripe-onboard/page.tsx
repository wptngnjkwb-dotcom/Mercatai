'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CheckCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

interface OnboardingCountry {
  code: string
  label: string
  supportsSepaDebit: boolean
}
interface OnboardingCountryGroup {
  label: string
  countries: OnboardingCountry[]
}

export default function StripeOnboardPage() {
  const t = useTranslations('stripeOnboarding')
  const searchParams = useSearchParams()
  const success = searchParams.get('success')
  const refresh = searchParams.get('refresh')
  const agentDbId = searchParams.get('agent_db_id')
  const taskId = searchParams.get('task_id')

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [onboardingUrl, setOnboardingUrl] = useState('')
  const [error, setError] = useState('')
  const [stripeStatus, setStripeStatus] = useState<any>(null)
  const [country, setCountry] = useState('')
  // Countries Mercatai currently has enabled are a server-side fact (see
  // frontend/lib/server/stripeConnectCountries.ts) — fetched at runtime
  // rather than imported statically, since the enabled subset depends on an
  // env var a client bundle cannot read.
  const [countryGroups, setCountryGroups] = useState<OnboardingCountryGroup[]>([])
  // Registration-supported (countryGroups above) is NOT the same as
  // payment-enabled — a country can accept onboarding while Mercatai has
  // not yet turned on live Direct Charge payments for it. See
  // GET /api/v1/onboarding-countries's own payment_enabled_country_codes.
  const [paymentEnabledCountryCodes, setPaymentEnabledCountryCodes] = useState<string[]>([])
  const [countriesLoaded, setCountriesLoaded] = useState(false)
  const [accountRequirement, setAccountRequirement] = useState<'standard_agent_liability' | 'legacy_express_platform_liability'>('standard_agent_liability')
  // React Strict Mode double-invokes effects in development — without this
  // guard, landing on ?refresh=1 there would fire the link-refresh request
  // twice. Only one has any real effect (both would mint a valid link for
  // the same account, never a second account), but there's no reason to
  // waste the extra Stripe call or risk a redirect race between the two
  // responses.
  const refreshStartedRef = useRef(false)

  useEffect(() => {
    fetch('/api/v1/onboarding-countries')
      .then((res) => res.json())
      .then((data) => {
        setCountryGroups(data.groups || [])
        setPaymentEnabledCountryCodes(data.payment_enabled_country_codes || [])
      })
      .catch(() => {
        setCountryGroups([])
        setPaymentEnabledCountryCodes([])
      })
      .finally(() => setCountriesLoaded(true))
  }, [])

  useEffect(() => {
    if (!taskId) {
      setAccountRequirement('standard_agent_liability')
      return
    }
    fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.stripe_account_requirement === 'legacy_express_platform_liability') {
          setAccountRequirement('legacy_express_platform_liability')
        } else {
          setAccountRequirement('standard_agent_liability')
        }
      })
      .catch(() => setAccountRequirement('standard_agent_liability'))
  }, [taskId])

  useEffect(() => {
    if (success && agentDbId) {
      checkStatus()
    }
  }, [success, agentDbId])

  useEffect(() => {
    if (refresh === '1' && agentDbId && !refreshStartedRef.current) {
      refreshStartedRef.current = true
      refreshOnboardingLink()
    }
  }, [refresh, agentDbId])

  async function checkStatus() {
    setStatus('loading')
    try {
      const token = localStorage.getItem('access_token')
      const taskQuery = taskId ? `?task_id=${encodeURIComponent(taskId)}` : ''
      const res = await fetch(`/api/v1/agents/${agentDbId}/stripe-onboard${taskQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setStripeStatus(data)
      setStatus('done')
    } catch {
      setStatus('error')
      setError(t('errors.status'))
    }
  }

  async function refreshOnboardingLink() {
    setStatus('loading')
    setError('')
    const token = localStorage.getItem('access_token')
    if (!token) {
      // A missing/invalid session must end here, in a clear message — never
      // fall through to re-fetching or silently retrying, which could loop
      // between this page and Stripe indefinitely.
      setStatus('error')
      setError(t('errors.session'))
      return
    }
    try {
      const res = await fetch(`/api/v1/agents/${agentDbId}/stripe-onboard/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(taskId ? { task_id: taskId } : {}),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('errors.refresh'))
      window.location.href = data.onboarding_url
    } catch (e: any) {
      setStatus('error')
      setError(e.message || t('errors.refresh'))
    }
  }

  async function startOnboarding() {
    const agentId = localStorage.getItem('agent_id')
    if (!agentId) {
      setError(t('errors.agentId'))
      return
    }
    if (!country) {
      setError(t('errors.country'))
      return
    }
    setStatus('loading')
    try {
      const token = localStorage.getItem('access_token')
      const res = await fetch(`/api/v1/agents/${agentId}/stripe-onboard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ country, ...(taskId ? { task_id: taskId } : {}) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      window.location.href = data.onboarding_url
    } catch (e: any) {
      setStatus('error')
      setError(e.message)
    }
  }

  if (refresh === '1') {
    // A malformed refresh link (no agent_db_id) must not spin forever
    // waiting on an effect that will never fire — fail immediately.
    if (!agentDbId || status === 'error') {
      return (
        <div className="max-w-lg mx-auto px-4 py-20 text-center">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-6">
            <AlertCircle size={32} className="text-red-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{t('resumeErrorTitle')}</h1>
          <p className="text-gray-500 mb-6">
            {!agentDbId ? t('errors.missingLink') : error}
          </p>
          <a href="/agent/dashboard" className="btn-primary inline-flex">{t('dashboard')}</a>
        </div>
      )
    }
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <Loader2 size={32} className="animate-spin mx-auto text-brand-600 mb-4" />
        <p className="text-gray-500">{t('refreshing')}</p>
      </div>
    )
  }

  if (success && stripeStatus?.onboarding_completed) {
    // Verified onboarding is necessary but NOT sufficient for live
    // payments — Mercatai gates actual Direct Charge creation separately,
    // per country (see stripeStatus.payment_enabled, computed server-side
    // from the SAME gate POST /api/v1/payments/create-intent enforces).
    // Claiming "you will receive payments" for a country that gate would
    // currently refuse is exactly the false promise this field exists to
    // prevent.
    const paymentEnabled = stripeStatus.payment_enabled === true
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
          <CheckCircle size={32} className="text-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">{t('activeTitle')}</h1>
        <p className="text-gray-500 mb-6">
          {paymentEnabled
            ? t('activeReady')
            : t('activeCountryPending')}
        </p>
        <div className="card p-4 text-left text-sm space-y-2">
          <div className="flex justify-between"><span className="text-gray-500">{t('stripeAccount')}</span><span className="font-mono text-xs">{stripeStatus.stripe_account_id}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">{t('chargesEnabled')}</span><span>{stripeStatus.charges_enabled ? t('yes') : t('no')}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">{t('payoutsEnabled')}</span><span>{stripeStatus.payouts_enabled ? t('yes') : t('no')}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">{t('countryPayments')}</span><span>{paymentEnabled ? t('yes') : t('notYet')}</span></div>
        </div>
        <a href="/agent/dashboard" className="btn-primary mt-6 inline-flex">{t('dashboard')}</a>
      </div>
    )
  }

  if (success && status === 'loading') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <Loader2 size={32} className="animate-spin mx-auto text-brand-600 mb-4" />
        <p className="text-gray-500">{t('checking')}</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('title')}</h1>
      <p className="text-gray-500 mb-8">{t('intro')}</p>

      {accountRequirement === 'legacy_express_platform_liability' ? (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{t('legacyTitle')}</strong> {t('legacyBody')}
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <strong>{t('standardTitle')}</strong> {t('standardBody')}
        </div>
      )}

      <div className="card p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('countryLabel')}</label>
          <select
            className="input w-full"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={!countriesLoaded}
          >
            <option value="">{countriesLoaded ? t('selectCountry') : t('loadingCountries')}</option>
            {countryGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            {t('countryMustMatch')}{' '}
            {(() => {
              const selected = country ? countryGroups.flatMap((g) => g.countries).find((c) => c.code === country) : undefined
              if (selected) {
                return selected.supportsSepaDebit
                  ? t('supportsCardSepa')
                  : t('supportsCardOnly')
              }
              return t('countrySupportDefault')
            })()}
            {' '}{t('stripeConfirms')}
          </p>
          {country && countriesLoaded && !paymentEnabledCountryCodes.includes(country) && (
            <p className="text-xs text-amber-600 mt-1">
              {t('countryNotEnabled')}
            </p>
          )}
        </div>

        <div className="space-y-3 text-sm text-gray-600">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">1</span>
            <span>{t('step1')}</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">2</span>
            <span>{t('step2')}</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">3</span>
            <span>{t('step3')}</span>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-700 space-y-1">
          <p><strong>{t('feesTitle')}</strong> {t('feesBody')}</p>
          <p>{t('feesExample')}</p>
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
            <><Loader2 size={16} className="animate-spin mr-2" />{t('connecting')}</>
          ) : (
            <><ExternalLink size={16} className="mr-2" />{t('connect')}</>
          )}
        </button>

        <p className="text-xs text-center text-gray-400">
          {t('linkNote')}
        </p>
      </div>
    </div>
  )
}
