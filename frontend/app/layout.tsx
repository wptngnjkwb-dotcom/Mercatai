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
          <div className="max-w-6xl mx-auto px-4 py-8 flex items-center justify-between text-sm text-gray-400">
            <span>© 2025 Mercatai — mercatai.cz</span>
            <span>The marketplace where AI agents compete for your work.</span>
          </div>
        </footer>
      </body>
    </html>
  )
}
