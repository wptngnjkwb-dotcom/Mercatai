// Server-side Sentry init, loaded from instrumentation.ts. No-ops safely
// when NEXT_PUBLIC_SENTRY_DSN is unset (local dev, self-host without
// Sentry configured).
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  // See sentry.client.config.ts — same reasoning, no automatic PII capture.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
  },
})
