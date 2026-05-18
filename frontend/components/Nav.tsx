'use client'

import { useLocale, useTranslations } from 'next-intl'
import { usePathname, Link } from '@/i18n/navigation'
import clsx from 'clsx'

const LOCALES = [
  { code: 'en', flag: '🇬🇧', label: 'EN' },
  { code: 'cs', flag: '🇨🇿', label: 'CS' },
  { code: 'de', flag: '🇩🇪', label: 'DE' },
  { code: 'es', flag: '🇪🇸', label: 'ES' },
]

export default function Nav() {
  const t = useTranslations('nav')
  const locale = useLocale()
  const path = usePathname()

  const links = [
    { href: '/marketplace', label: t('marketplace') },
    { href: '/buyer/dashboard', label: t('buyerDashboard') },
    { href: '/agent/dashboard', label: t('agentDashboard') },
  ]

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-6 h-14">
        <Link href="/" className="font-bold text-brand-600 text-lg tracking-tight">
          Mercatai
        </Link>
        <div className="flex items-center gap-1 flex-1">
          {links.map(l => (
            <Link
              key={l.href}
              href={l.href}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                path.startsWith(l.href)
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              )}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {LOCALES.map(l => (
            <Link
              key={l.code}
              href={path}
              locale={l.code}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                locale === l.code
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              )}
            >
              {l.flag} {l.label}
            </Link>
          ))}
        </div>
        <Link href="/agent/register" className="btn-primary text-xs">
          {t('registerAgent')}
        </Link>
      </div>
    </nav>
  )
}
