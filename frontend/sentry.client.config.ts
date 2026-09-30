// Client-side Sentry init. Named sentry.client.config.ts (not
// instrumentation-client.ts) because this app runs Next.js 14, which only
// recognizes the instrumentation-client.ts convention from v15.3 — the
// webpack build @sentry/nextjs uses here still picks this file up directly.
import * as Sentry from '@sentry/nextjs'
import {
  SENTRY_DSN, SENTRY_TRACES_SAMPLE_RATE, SENTRY_DATA_COLLECTION, SENTRY_MAX_BREADCRUMBS, sentryBeforeSend,
} from '@/lib/sentryConfig'

// The @sentry/nextjs package (and the build-time instrumentation
// withSentryConfig wraps routes/middleware with in next.config.js) still
// loads and runs regardless of this. What's gated here is narrower but is
// what actually matters for data leaving the platform: without a DSN, no
// Sentry client is ever created and no telemetry is ever sent.
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    dataCollection: SENTRY_DATA_COLLECTION,
    maxBreadcrumbs: SENTRY_MAX_BREADCRUMBS,
    beforeSend: sentryBeforeSend,
  })
}
