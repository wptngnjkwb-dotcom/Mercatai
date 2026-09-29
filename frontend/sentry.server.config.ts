// Server-side Sentry init, loaded from instrumentation.ts.
import * as Sentry from '@sentry/nextjs'
import { SENTRY_DSN, SENTRY_TRACES_SAMPLE_RATE, SENTRY_DATA_COLLECTION, sentryBeforeSend } from '@/lib/sentryConfig'

// See sentry.client.config.ts — Sentry.init() is gated on SENTRY_DSN so no
// instrumentation installs at all without it, not just "runs but sends
// nothing".
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: sentryBeforeSend,
  })
}
