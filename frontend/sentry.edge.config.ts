// Edge runtime Sentry init (middleware.ts runs here), loaded from
// instrumentation.ts.
import * as Sentry from '@sentry/nextjs'
import {
  SENTRY_DSN, SENTRY_TRACES_SAMPLE_RATE, SENTRY_DATA_COLLECTION, SENTRY_MAX_BREADCRUMBS, sentryBeforeSend,
} from '@/lib/sentryConfig'

// See sentry.client.config.ts — same DSN gating and the same caveat about
// what does and doesn't load without it.
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    dataCollection: SENTRY_DATA_COLLECTION,
    maxBreadcrumbs: SENTRY_MAX_BREADCRUMBS,
    beforeSend: sentryBeforeSend,
  })
}
