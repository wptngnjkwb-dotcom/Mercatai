// Client-side Sentry init. Named sentry.client.config.ts (not
// instrumentation-client.ts) because this app runs Next.js 14, which only
// recognizes the instrumentation-client.ts convention from v15.3 — the
// webpack build @sentry/nextjs uses here still picks this file up directly.
import * as Sentry from '@sentry/nextjs'
import { SENTRY_DSN, SENTRY_TRACES_SAMPLE_RATE, SENTRY_DATA_COLLECTION, sentryBeforeSend } from '@/lib/sentryConfig'

// Sentry.init() itself installs global instrumentation (wraps fetch,
// listens for unhandled errors, etc.) — calling it with dsn: undefined
// still does all of that, it just has nowhere to send events. Gating the
// call itself means none of that runs at all without a DSN configured, not
// just "runs but sends nothing".
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: sentryBeforeSend,
  })
}
