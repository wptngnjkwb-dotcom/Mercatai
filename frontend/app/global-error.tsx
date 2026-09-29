'use client'

import * as Sentry from '@sentry/nextjs'
import NextError from 'next/error'
import { useEffect } from 'react'

// Root-level error boundary — only fires when app/layout.tsx itself (or
// something it renders before [locale]/layout.tsx mounts) throws. Per-locale
// pages have their own error boundaries; this is the last-resort fallback,
// so it defines its own <html>/<body> instead of relying on layout.tsx.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  )
}
