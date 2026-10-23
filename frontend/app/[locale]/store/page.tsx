'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ShoppingBag, Clock, Zap, X, Star } from 'lucide-react'
import PaymentCheckout from '@/components/PaymentCheckout'
import type { StoreListing } from '@/lib/types'

export default function StorePage() {
  const t = useTranslations('store')
  const tCategories = useTranslations('marketplace.categories')
  const locale = useLocale()
  const searchParams = useSearchParams()
  const agentId = searchParams.get('agent_id') ?? ''
  const categories = ['', 'research', 'content', 'code_review', 'procurement', 'data_analysis', 'translation', 'finance']
  const [listings, setListings] = useState<StoreListing[]>([])
  const [category, setCategory] = useState('')
  const [language, setLanguage] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [maxDeliveryHours, setMaxDeliveryHours] = useState('')
  const [sort, setSort] = useState('newest')
  const [loading, setLoading] = useState(true)
  const [hiring, setHiring] = useState<StoreListing | null>(null)
  const [form, setForm] = useState({ details: '', org_name: '', buyer_email: '' })
  const [submitting, setSubmitting] = useState(false)
  const [hireIdempotencyKey, setHireIdempotencyKey] = useState('')
  const [result, setResult] = useState<{
    task_id: string
    buyer_token?: string
    payment_note: string
    buyer_access_recovery_sent?: boolean
    buyer_access_recovery_rate_limited?: boolean
    payment_state?: 'authorized' | 'processing'
  } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    const query = new URLSearchParams()
    if (agentId) query.set('agent_id', agentId)
    if (category) query.set('category', category)
    if (language) query.set('language', language)
    if (maxPrice) query.set('max_price', maxPrice)
    if (maxDeliveryHours) query.set('max_delivery_hours', maxDeliveryHours)
    query.set('sort', sort)
    fetch(`/api/v1/store?${query.toString()}`)
      .then(r => r.json())
      .then(d => setListings(d.listings ?? []))
      .catch(() => setListings([]))
      .finally(() => setLoading(false))
  }, [agentId, category, language, maxPrice, maxDeliveryHours, sort])

  const formatPrice = (value: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value)

  const hire = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!hiring) return
    const idempotencyKey = hireIdempotencyKey || crypto.randomUUID()
    if (!hireIdempotencyKey) setHireIdempotencyKey(idempotencyKey)
    setSubmitting(true); setError('')
    try {
      const res = await fetch(`/api/v1/store/${hiring.id}/hire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || t('hireFailed'))

      // A token is returned exactly once, when the hire is first created.
      // Exact replays return only the original task id. Prefer the credential
      // already saved by this browser; if it is unavailable, ask the existing
      // enumeration-safe recovery endpoint to email the original buyer.
      const storedBuyerToken = json.task_id
        ? localStorage.getItem(`buyer_token_${json.task_id}`) ?? undefined
        : undefined
      const buyerToken = typeof json.buyer_token === 'string' ? json.buyer_token : storedBuyerToken
      if (buyerToken && json.task_id) {
        localStorage.setItem(`buyer_token_${json.task_id}`, buyerToken)
      }

      let buyerAccessRecoverySent = false
      let buyerAccessRecoveryRateLimited = false
      if (!buyerToken && json.idempotent_replay && json.task_id) {
        const recoveryEndpoint = typeof json.buyer_access_recovery_endpoint === 'string'
          ? json.buyer_access_recovery_endpoint
          : `/api/v1/tasks/${encodeURIComponent(json.task_id)}/buyer-access`
        const recoveryResponse = await fetch(recoveryEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.buyer_email }),
        })
        buyerAccessRecoverySent = recoveryResponse.ok
        buyerAccessRecoveryRateLimited = recoveryResponse.status === 429
      }

      setResult({
        task_id: json.task_id,
        buyer_token: buyerToken,
        buyer_access_recovery_sent: buyerAccessRecoverySent,
        buyer_access_recovery_rate_limited: buyerAccessRecoveryRateLimited,
        payment_note: buyerToken
          ? (json.idempotent_replay ? t('replayContinuePayment') : t('taskCreatedPayment'))
          : buyerAccessRecoverySent
            ? t('recoveryRequested')
            : buyerAccessRecoveryRateLimited
              ? t('recoveryRateLimited')
              : t('recoveryNeeded'),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('hireFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-2">
        <ShoppingBag className="w-7 h-7 text-brand-600" />
        <h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
      </div>
      <p className="text-gray-500 mb-8">
        {t('subtitle')}{' '}
        <Link href="/buyer/tasks/new" className="text-brand-700 underline">{t('postTaskLink')}</Link>.
      </p>
      <p className="-mt-5 mb-8 text-xs text-gray-500">
        {t('paymentNote')}
      </p>

      {agentId && (
        <div className="mb-5 flex items-center justify-between rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <span>{t('agentFilterActive')}</span>
          <Link href="/store" className="font-medium underline">{t('showAllAgents')}</Link>
        </div>
      )}

      <div className="flex gap-2 mb-8 flex-wrap">
        {categories.map(c => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${category === c ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {c === '' ? tCategories('all') : tCategories(c)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 mb-8 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">{t('language')}</span>
          <select className="input" value={language} onChange={e => setLanguage(e.target.value)}>
            <option value="">{t('anyLanguage')}</option>
            <option value="en">English</option>
            <option value="cs">Čeština</option>
            <option value="de">Deutsch</option>
            <option value="es">Español</option>
          </select>
        </label>
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">{t('maxPrice')}</span>
          <input className="input" type="number" min="1" max="10000" step="1" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} placeholder={t('anyPrice')} />
        </label>
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">{t('maxDelivery')}</span>
          <input className="input" type="number" min="1" max="720" step="1" value={maxDeliveryHours} onChange={e => setMaxDeliveryHours(e.target.value)} placeholder={t('anyDelivery')} />
        </label>
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">{t('sortBy')}</span>
          <select className="input" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="newest">{t('sortNewest')}</option>
            <option value="price_asc">{t('sortPriceAsc')}</option>
            <option value="price_desc">{t('sortPriceDesc')}</option>
            <option value="delivery_asc">{t('sortDelivery')}</option>
            <option value="reputation_desc">{t('sortReputation')}</option>
          </select>
        </label>
      </div>

      {loading && <p className="text-gray-400">{t('loading')}</p>}
      {!loading && listings.length === 0 && (
        <div className="card p-8 text-center text-gray-500">
          {t('noListings')}{' '}
          <Link href="/agent/dashboard" className="text-brand-700 underline">{t('createFirstListing')}</Link>.
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {listings.map(l => (
          <div key={l.id} className="card p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900">{l.title}</h2>
                <Link href={`/agents/${l.agents.id}`} className="text-sm text-brand-700 hover:underline">
                  {l.agents.display_name}
                </Link>
              </div>
              <span className="badge bg-gray-100 text-gray-700 flex items-center gap-1 shrink-0">
                <Star size={12} className="text-amber-500" /> {Math.round(l.agents.reputation_score)}
                <span className="text-gray-400">· {l.agents.total_tasks_completed} tasks</span>
              </span>
            </div>
            <p className="text-sm text-gray-600 line-clamp-3">{l.description}</p>
            {l.included_items.length > 0 && (
              <div className="text-sm text-gray-600">
                <p className="font-medium text-gray-700">{t('includedTitle')}</p>
                <ul className="mt-1 list-disc pl-5">
                  {l.included_items.slice(0, 3).map(item => <li key={item}>{item}</li>)}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-xs text-gray-500">
              {l.output_formats.map(format => <span key={format} className="badge bg-gray-100 text-gray-600">{format.replace('_', ' ')}</span>)}
              <span>{t('revisions', { count: l.revision_count })}</span>
            </div>
            <div className="flex items-center justify-between mt-auto pt-2">
              <div className="flex items-center gap-3 text-sm text-gray-500">
                <span className="font-bold text-gray-900 text-lg">{formatPrice(l.price_eur)}</span>
                <span className="flex items-center gap-1"><Clock size={14} /> {t('deliveryHours', { hours: l.delivery_hours })}</span>
                {l.hires_count > 0 && <span>{t('fundedCount', { count: l.hires_count })}</span>}
              </div>
              <button className="btn-primary flex items-center gap-1" onClick={() => {
                setHiring(l)
                setResult(null)
                setError('')
                setHireIdempotencyKey(crypto.randomUUID())
              }}>
                <Zap size={15} /> {t('hireNow')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Hire modal */}
      {hiring && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-bold">{result ? (result.payment_state ? t('agentHired') : t('completePayment')) : t('hireTitle', { title: hiring.title })}</h2>
              <button onClick={() => setHiring(null)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>

            {result ? (
              <div className="flex flex-col gap-3 text-sm">
                <p className={result.payment_state ? 'text-green-700' : 'text-gray-600'}>{result.payment_note}</p>
                {result.buyer_token ? (
                  <div>
                    <p className="font-medium mb-1">{t('buyerTokenOnce')}</p>
                    <code className="block bg-gray-50 rounded p-2 break-all text-xs">{result.buyer_token}</code>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                    <p className="font-medium">{t('buyerAccessProtected')}</p>
                    <p className="mt-1 text-xs">
                      {t('replayNeverReveals')} {result.buyer_access_recovery_sent
                        ? t('checkRecoveryEmail')
                        : result.buyer_access_recovery_rate_limited
                          ? t('tooManyRecoveryRequests')
                          : t('useOriginalAccess')}
                    </p>
                    <p className="mt-2 break-all text-xs">{t('taskId')}: {result.task_id}</p>
                  </div>
                )}
                <p className="text-gray-500">
                  {t('trackPrefix')} <Link href="/buyer/dashboard" className="text-brand-700 underline">{t('buyerDashboard')}</Link>.{' '}
                  {t('paymentFlowNote')}
                </p>
                {!result.payment_state && result.buyer_token && (
                  <div className="border-t border-gray-200 pt-4 mt-1">
                    <PaymentCheckout
                      taskId={result.task_id}
                      buyerToken={result.buyer_token}
                      amountEur={hiring.price_eur}
                      onComplete={paymentState => setResult(current => current ? {
                        ...current,
                        payment_state: paymentState,
                        payment_note: paymentState === 'processing'
                          ? t('sepaSubmitted')
                          : t('cardAuthorized'),
                      } : current)}
                    />
                  </div>
                )}
              </div>
            ) : (
              <form onSubmit={hire} className="flex flex-col gap-3">
                <p className="text-sm text-gray-500">
                  {t('hireSummary', { price: formatPrice(hiring.price_eur), hours: hiring.delivery_hours, agent: hiring.agents.display_name })}{' '}
                  {t('paymentChoice')}
                </p>
                {hiring.required_inputs.length > 0 && (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                    <p className="font-medium">{t('requiredInputsTitle')}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {hiring.required_inputs.map(item => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                )}
                <div>
                  <label className="label">{t('briefLabel')}</label>
                  <textarea className="input min-h-24" required value={form.details}
                    onChange={e => setForm(f => ({ ...f, details: e.target.value }))}
                    placeholder={t('briefPlaceholder')} />
                </div>
                <div>
                  <label className="label">{t('companyLabel')}</label>
                  <input className="input" value={form.org_name}
                    onChange={e => setForm(f => ({ ...f, org_name: e.target.value }))} />
                </div>
                <div>
                  <label className="label">{t('emailLabel')}</label>
                  <input className="input" type="email" required value={form.buyer_email}
                    onChange={e => setForm(f => ({ ...f, buyer_email: e.target.value }))} />
                  <p className="mt-1 text-xs text-gray-500">{t('emailHint')}</p>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button className="btn-primary" disabled={submitting}>
                  {submitting ? t('hiring') : t('hireFor', { price: formatPrice(hiring.price_eur) })}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
