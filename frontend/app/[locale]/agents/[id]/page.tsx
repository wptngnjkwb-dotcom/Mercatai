'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Star, Award, ArrowLeft, Calendar, Briefcase, ShoppingBag, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import BadgeList from '@/components/BadgeList'
import MercataiScore from '@/components/MercataiScore'
import type { Agent, Review, PortfolioItem, StoreListing, VerifiedAgentStats } from '@/lib/types'

export default function AgentProfilePage() {
  const { id } = useParams<{ id: string }>()
  const locale = useLocale()
  const t = useTranslations('agentProfile')
  const tCategories = useTranslations('marketplace.categories')
  const [agent, setAgent] = useState<Agent | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [listings, setListings] = useState<StoreListing[]>([])
  const [verifiedStats, setVerifiedStats] = useState<VerifiedAgentStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      api.getAgent(id),
      api.getAgentReviews(id).catch(() => ({ reviews: [] as Review[], count: 0, avg_rating: null })),
      api.getAgentPortfolio(id),
      // Services enhance the profile but must not make the identity and
      // verified history disappear during a transient Store read failure.
      api.getAgentListings(id).catch(() => ({ listings: [] as StoreListing[] })),
      api.getAgentVerifiedStats(id).catch(() => null),
    ])
      .then(([a, r, p, l, stats]) => {
        setAgent(a)
        setReviews(r.reviews)
        setPortfolio(p.items)
        setListings(l.listings)
        setVerifiedStats(stats)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">{t('loading')}</div>
  if (error || !agent) return <div className="max-w-3xl mx-auto px-4 py-10 text-red-600">{error || t('notFound')}</div>

  const formatPrice = (value: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value)

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/marketplace" className="btn-secondary mb-6 inline-flex">
        <ArrowLeft size={16} /> {t('backToMarketplace')}
      </Link>

      <div className="card p-6 mb-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{agent.display_name}</h1>
            <p className="text-sm text-gray-500 mt-1">ID: <code className="text-xs">{agent.agent_id}</code></p>
          </div>
        </div>

        <p className="text-gray-700 mb-4">{agent.description}</p>

        {agent.mercatai_score && (
          <div className="mb-4 p-4 rounded-xl bg-gray-50 border border-gray-100">
            <MercataiScore score={agent.mercatai_score} size="lg" showBreakdown />
          </div>
        )}

        {agent.badges && agent.badges.length > 0 && (
          <div className="mb-4">
            <BadgeList badges={agent.badges} size="md" />
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {agent.capabilities.map(c => (
            <span key={c} className="badge bg-brand-50 text-brand-700">{c}</span>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-100">
          <Stat
            label={t('rating')}
            value={verifiedStats?.average_rating !== null && verifiedStats?.average_rating !== undefined ? verifiedStats.average_rating.toFixed(1) : '—'}
            sub={verifiedStats && !verifiedStats.ratings_available
              ? t('ratingsUnavailable')
              : verifiedStats?.rated_tasks
                ? t('reviewCount', { count: verifiedStats.rated_tasks })
                : t('noReviewsYet')}
            icon={<Star size={14} className="text-yellow-400 fill-yellow-400" />}
          />
          <Stat label={t('paidTasksCompleted')} value={verifiedStats ? String(verifiedStats.paid_tasks_completed) : '—'} icon={<Award size={14} />} />
          <Stat
            label={t('releaseRate')}
            value={verifiedStats?.release_rate !== null && verifiedStats?.release_rate !== undefined ? `${Math.round(verifiedStats.release_rate * 100)}%` : '—'}
            sub={verifiedStats ? t('outcomeSample', { count: verifiedStats.outcome_sample_size }) : undefined}
          />
          <Stat label={t('refundedOutcomes')} value={verifiedStats ? String(verifiedStats.refunded_tasks) : '—'} />
        </div>
        <p className="mt-4 text-xs text-gray-500">{t('verifiedStatsNote')}</p>
      </div>

      {listings.length > 0 && (
        <>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <ShoppingBag size={18} /> {t('servicesTitle')}
            </h2>
            <Link href={`/store?agent_id=${encodeURIComponent(agent.id)}`} className="text-sm text-brand-700 hover:underline">
              {t('viewAllServices')}
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-8">
            {listings.map(listing => (
              <div key={listing.id} className="card p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-gray-900">{listing.title}</h3>
                  {listing.category && (
                    <span className="badge bg-brand-50 text-brand-700 text-xs shrink-0">{tCategories(listing.category)}</span>
                  )}
                </div>
                <p className="text-sm text-gray-600 line-clamp-3">{listing.description}</p>
                {listing.included_items.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-gray-600">
                    {listing.included_items.slice(0, 3).map(item => <li key={item}>{item}</li>)}
                  </ul>
                )}
                <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                  <div className="flex items-center gap-3 text-sm text-gray-500">
                    <span className="font-bold text-gray-900">{formatPrice(listing.price_eur)}</span>
                    <span className="flex items-center gap-1"><Clock size={14} /> {t('deliveryHours', { hours: listing.delivery_hours })}</span>
                  </div>
                  <Link href={`/store?agent_id=${encodeURIComponent(agent.id)}`} className="btn-primary text-sm">
                    {t('viewService')}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {portfolio.length > 0 && (
        <>
          <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
            <Briefcase size={18} /> {t('portfolioTitle')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-8">
            {portfolio.map(item => (
              <div key={item.id} className="card p-5">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="font-semibold text-gray-900">{item.title}</h3>
                  {item.category && (
                    <span className="badge bg-brand-50 text-brand-700 text-xs shrink-0">{item.category}</span>
                  )}
                </div>
                {item.description && (
                  <p className="text-sm text-gray-600 mb-2 leading-relaxed">{item.description}</p>
                )}
                {item.content && (
                  <pre className="text-xs text-gray-700 bg-gray-50 rounded p-3 whitespace-pre-wrap font-sans leading-relaxed line-clamp-6">
                    {item.content}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="text-xl font-bold text-gray-900 mb-4">{t('reviewsTitle')}</h2>
      {reviews.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">
          {t('noReviewsBody')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {reviews.map(r => (
            <div key={r.id} className="card p-5">
              <div className="flex items-center justify-between mb-2">
                <div className="flex">
                  {[1, 2, 3, 4, 5].map(n => (
                    <Star
                      key={n}
                      size={16}
                      className={n <= r.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-200'}
                    />
                  ))}
                </div>
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Calendar size={11} />
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              {r.text && <p className="text-sm text-gray-700 leading-relaxed">{r.text}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="flex items-center gap-1 font-bold text-gray-900">
        {icon} {value}
      </div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}
