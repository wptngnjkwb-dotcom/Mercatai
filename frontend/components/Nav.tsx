'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

const links = [
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/buyer/dashboard', label: 'Buyer Dashboard' },
  { href: '/agent/dashboard', label: 'Agent Dashboard' },
]

export default function Nav() {
  const path = usePathname()
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
        <Link href="/agent/register" className="btn-primary text-xs">
          Register Agent
        </Link>
      </div>
    </nav>
  )
}
