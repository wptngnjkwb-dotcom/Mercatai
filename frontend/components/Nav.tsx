'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname, Link } from '@/i18n/navigation'
import { Menu, X } from 'lucide-react'
import clsx from 'clsx'
import { BRAND_NAME, BRAND_LOGO_URL } from '@/lib/branding'

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
  const [open, setOpen] = useState(false)

  // Close the drawer on navigation — otherwise it stays open over the new page
  useEffect(() => { setOpen(false) }, [path])

  const links = [
    { href: '/store', label: t('store') },
    { href: '/marketplace', label: t('marketplace') },
    { href: '/live', label: t('live') },
    { href: '/buyer/dashboard', label: t('buyerDashboard') },
    { href: '/agent/dashboard', label: t('agentDashboard') },
  ]

  const localeSwitcher = (size: 'sm' | 'base') => (
    <div className="flex items-center gap-1">
      {LOCALES.map(l => (
        <Link
          key={l.code}
          href={path}
          locale={l.code}
          className={clsx(
            'flex items-center gap-1 rounded font-medium transition-colors',
            size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm',
            locale === l.code
              ? 'bg-brand-50 text-brand-700'
              : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          )}
        >
          {l.flag} {l.label}
        </Link>
      ))}
    </div>
  )

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-4 lg:gap-6 h-14">
        <Link href="/" className="font-bold text-brand-600 text-lg tracking-tight flex items-center gap-2 shrink-0">
          {BRAND_LOGO_URL && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={BRAND_LOGO_URL} alt="" className="h-7 w-auto" />
          )}
          {BRAND_NAME}
        </Link>

        {/* Desktop navigation */}
        <div className="hidden lg:flex items-center gap-1 flex-1">
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

        <div className="hidden lg:flex items-center gap-1">{localeSwitcher('sm')}</div>

        <Link href="/try" className="hidden lg:inline-flex px-3 py-1.5 rounded-lg text-sm font-medium text-brand-700 hover:bg-brand-50 transition-colors">
          {t('tryIt')}
        </Link>
        <Link href="/agent/register" className="hidden sm:inline-flex btn-primary text-xs shrink-0">
          {t('registerAgent')}
        </Link>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="lg:hidden ml-auto p-2 -mr-2 rounded-lg text-gray-600 hover:bg-gray-50"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div id="mobile-menu" className="lg:hidden border-t border-gray-200 bg-white">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-1">
            {links.map(l => (
              <Link
                key={l.href}
                href={l.href}
                className={clsx(
                  'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  path.startsWith(l.href)
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                )}
              >
                {l.label}
              </Link>
            ))}
            <Link href="/try" className="px-3 py-2 rounded-lg text-sm font-medium text-brand-700 hover:bg-brand-50 transition-colors">
              {t('tryIt')}
            </Link>
            <Link href="/agent/register" className="sm:hidden px-3 py-2 rounded-lg text-sm font-medium text-brand-700 hover:bg-brand-50 transition-colors">
              {t('registerAgent')}
            </Link>
            <div className="pt-2 mt-1 border-t border-gray-100">{localeSwitcher('base')}</div>
          </div>
        </div>
      )}
    </nav>
  )
}
