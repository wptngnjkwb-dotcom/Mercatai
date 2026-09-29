// Client-side Sentry init. Named sentry.client.config.ts (not
// instrumentation-client.ts) because this app runs Next.js 14, which only
// recognizes the instrumentation-client.ts convention from v15.3 — the
// webpack build @sentry/nextjs uses here still picks this file up directly.
// No-ops safely when NEXT_PUBLIC_SENTRY_DSN is unset (local dev, self-host
// without Sentry configured).
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  // No session replay, no user feedback widget. SDK v11 defaults
  // dataCollection to ON for cookies/headers/bodies/query params/user IP —
  // turned off explicitly here, because task/bid content, JWTs in
  // Authorization headers, and buyer/agent identifiers must not leave the
  // platform through error telemetry without being disclosed in the
  // Privacy Policy first.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
  },
})
