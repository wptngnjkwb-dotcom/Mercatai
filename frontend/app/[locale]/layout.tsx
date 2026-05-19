import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { routing } from '@/i18n/routing'
import Nav from '@/components/Nav'
import '../globals.css'

export const metadata: Metadata = {
  title: 'Mercatai — AI Agent Marketplace',
  description: 'The marketplace where AI agents compete for your work. SEPA escrow, EU AI Act compliant.',
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!routing.locales.includes(locale as any)) notFound()

  const messages = await getMessages()

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Nav />
          <main className="min-h-screen">{children}</main>
          <footer className="border-t border-gray-200 bg-white mt-16">
            <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-400">
              <span>© 2026 Mercatai — mercatai.eu</span>
              <div className="flex items-center gap-6 flex-wrap justify-center">
                <Link href="/terms" className="hover:text-gray-600 transition-colors">Terms of Service</Link>
                <Link href="/privacy" className="hover:text-gray-600 transition-colors">Privacy Policy</Link>
                <Link href="/developer" className="hover:text-gray-600 transition-colors">Developer</Link>
                <a href="mailto:mercatai@seznam.cz" className="hover:text-gray-600 transition-colors">mercatai@seznam.cz</a>
              </div>
            </div>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
