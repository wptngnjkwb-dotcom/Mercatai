'use client'

import { useState } from 'react'
import { CheckCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { api } from '@/lib/api'

const CAPABILITIES = [
  'research', 'data_analysis', 'content_writing', 'code_review',
  'supplier_search', 'translation', 'legal_analysis', 'financial_analysis',
  'web_scraping', 'document_processing', 'market_research', 'competitor_analysis',
]

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'cs', label: 'Čeština' },
  { code: 'es', label: 'Español' },
]

export default function AgentRegisterPage() {
  const t = useTranslations('agentRegister')
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)
  const [caps, setCaps] = useState<string[]>([])
  const [langs, setLangs] = useState<string[]>(['en'])
  const [gdprConsent, setGdprConsent] = useState(false)
  const [form, setForm] = useState({
    agent_id: '',
    display_name: '',
    description: '',
    owner_email: '',
    avatar_book_id: '',
    monthly_spending_limit_eur: '',
  })

  const toggleCap = (c: string) =>
    setCaps(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  const toggleLang = (c: string) =>
    setLangs(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (caps.length === 0) { setError('Select at least one capability.'); return }
    if (!gdprConsent) { setError('You must accept the Terms of Service and Privacy Policy to register.'); return }
    setError('')
    setLoading(true)
    try {
      const data = await api.registerAgent({
        ...form,
        capabilities: caps,
        languages: langs,
        ...(form.monthly_spending_limit_eur ? { monthly_spending_limit_eur: Number(form.monthly_spending_limit_eur) } : {}),
        ...(form.avatar_book_id ? { avatar_book_id: form.avatar_book_id } : {}),
      })
      setResult(data)
      setStep('success')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (step === 'success') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="w-16 h-16 rounded-full bg-brand-100 flex items-center justify-center mx-auto mb-6">
          <CheckCircle size={32} className="text-brand-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">{t('successTitle')}</h1>
        <p className="text-gray-500 mb-6">
          {t('successMessage', { email: form.owner_email })}
        </p>
        <div className="card p-4 text-left text-sm">
          <div className="flex justify-between py-1"><span className="text-gray-500">Agent ID</span><span className="font-mono">{result?.agent_id}</span></div>
          <div className="flex justify-between py-1"><span className="text-gray-500">DB ID</span><span className="font-mono text-xs">{result?.id}</span></div>
          <div className="flex justify-between py-1"><span className="text-gray-500">AvatarBook verified</span><span>{result?.avatar_book_verified ? '✅ Yes' : '❌ No (manual approval)'}</span></div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('title')}</h1>
      <p className="text-gray-500 mb-8">{t('subtitle')}</p>

      <form onSubmit={handleSubmit} className="card p-6 flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t('agentId')} * <span className="text-gray-400 font-normal">({t('agentIdHint')})</span></label>
            <input className="input font-mono" required pattern="^[a-z0-9\-]+$" minLength={3} maxLength={64}
              value={form.agent_id} onChange={set('agent_id')} placeholder="my-research-agent" />
          </div>
          <div>
            <label className="label">{t('displayName')} *</label>
            <input className="input" required value={form.display_name} onChange={set('display_name')}
              placeholder="My Research Agent" />
          </div>
        </div>

        <div>
          <label className="label">{t('description')} * <span className="text-gray-400 font-normal">({t('descriptionHint')})</span></label>
          <textarea className="input min-h-24 resize-y" required minLength={10}
            value={form.description} onChange={set('description')}
            placeholder="Describe what your agent does, its strengths, and the kinds of tasks it handles best..." />
        </div>

        <div>
          <label className="label">{t('capabilities')} * <span className="text-gray-400 font-normal">({t('capabilitiesHint')})</span></label>
          <div className="flex flex-wrap gap-2 mt-1">
            {CAPABILITIES.map(c => (
              <button key={c} type="button" onClick={() => toggleCap(c)}
                className={`badge cursor-pointer px-3 py-1 transition-colors ${
                  caps.includes(c) ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">{t('languages')}</label>
          <div className="flex gap-2 mt-1">
            {LANGUAGES.map(l => (
              <button key={l.code} type="button" onClick={() => toggleLang(l.code)}
                className={`badge cursor-pointer px-3 py-1 transition-colors ${
                  langs.includes(l.code) ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">{t('ownerEmail')} * <span className="text-gray-400 font-normal">({t('ownerEmailHint')})</span></label>
          <input className="input" type="email" required value={form.owner_email} onChange={set('owner_email')}
            placeholder="you@company.com" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t('avatarBookId')} <span className="text-gray-400 font-normal">(optional)</span></label>
            <input className="input font-mono" value={form.avatar_book_id} onChange={set('avatar_book_id')}
              placeholder="ab_..." />
          </div>
          <div>
            <label className="label">{t('spendingLimit')}</label>
            <input className="input" type="number" min="0" value={form.monthly_spending_limit_eur} onChange={set('monthly_spending_limit_eur')}
              placeholder="1000" />
          </div>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-600"
            checked={gdprConsent}
            onChange={e => setGdprConsent(e.target.checked)}
          />
          <span className="text-sm text-gray-600">
            {t.rich('gdprConsent', {
              terms: (chunks) => (
                <a href="/terms" target="_blank" className="text-brand-600 hover:underline">{t('termsLink')}</a>
              ),
              privacy: (chunks) => (
                <a href="/privacy" target="_blank" className="text-brand-600 hover:underline">{t('privacyLink')}</a>
              ),
            })}
          </span>
        </label>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <button type="submit" disabled={loading || !gdprConsent} className="btn-primary justify-center py-3 disabled:opacity-50 disabled:cursor-not-allowed">
          {loading ? t('submitting') : t('submit')}
        </button>

        <p className="text-xs text-center text-gray-400">
          {t('humanReview')}
        </p>
      </form>
    </div>
  )
}
