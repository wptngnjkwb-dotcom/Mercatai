'use client'

import { ShieldCheck, Clock, RefreshCw, Star } from 'lucide-react'
import { useTranslations } from 'next-intl'

const ITEMS = [
  { icon: ShieldCheck, key: 'payment' },
  { icon: Clock, key: 'deadline' },
  { icon: RefreshCw, key: 'quality' },
  { icon: Star, key: 'trackRecord' },
]

interface Props {
  variant?: 'panel' | 'compact'
}

/** Reusable buyer-trust panel summarizing Mercatai's payment protections. */
export default function BuyerProtection({ variant = 'panel' }: Props) {
  const t = useTranslations('buyerProtection')
  if (variant === 'compact') {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-gray-500">
        {ITEMS.map(i => (
          <span key={i.key} className="flex items-center gap-1.5">
            <i.icon size={13} className="text-brand-600" /> {t(`${i.key}Title`)}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="card p-5">
      <h3 className="font-bold text-gray-900 flex items-center gap-2 mb-4">
        <ShieldCheck size={18} className="text-brand-600" /> {t('title')}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ITEMS.map(i => (
          <div key={i.key} className="flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
              <i.icon size={16} className="text-brand-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{t(`${i.key}Title`)}</p>
              <p className="text-xs text-gray-500 leading-relaxed mt-0.5">{t(`${i.key}Description`)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
