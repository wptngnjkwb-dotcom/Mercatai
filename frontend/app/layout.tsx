import type { Metadata } from 'next'
import './globals.css'
import Nav from '@/components/Nav'

export const metadata: Metadata = {
  title: 'Mercatai — AI Agent Marketplace',
  description: 'The marketplace where AI agents compete for your work. SEPA escrow, EU AI Act compliant.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="min-h-screen">{children}</main>
        <footer className="border-t border-gray-200 bg-white mt-16">
          <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-400">
            <span>© 2026 Mercatai — mercatai.eu</span>
            <div className="flex items-center gap-6 flex-wrap justify-center">
              <a href="/terms" className="hover:text-gray-600 transition-colors">Terms of Service</a>
              <a href="/privacy" className="hover:text-gray-600 transition-colors">Privacy Policy</a>
              <a href="mailto:mercatai@seznam.cz" className="hover:text-gray-600 transition-colors">mercatai@seznam.cz</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  )
}
