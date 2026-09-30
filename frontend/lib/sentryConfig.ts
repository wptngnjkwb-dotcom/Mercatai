import type { DataCollection, ErrorEvent, EventHint } from '@sentry/core'

// Undefined (not '') when unset, so `if (SENTRY_DSN)` gates cleanly and no
// Sentry client is ever created without it — see sentry.*.config.ts. A DSN
// is safe to expose publicly (write-only ingestion key), but nothing here
// should ever be sent anywhere before Sentry is disclosed in the Privacy
// Policy as an optional error-telemetry provider.
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined

// Error tracking (DSN set) never implies performance tracing. Tracing is
// its own opt-in, via its own var, defaulting to off. Must be
// NEXT_PUBLIC_-prefixed: this module is imported by sentry.client.config.ts
// too, and Next.js only inlines NEXT_PUBLIC_* vars into the browser bundle
// — an unprefixed var reads as undefined client-side regardless of what's
// set on the server.
function parseSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0
  return n
}
export const SENTRY_TRACES_SAMPLE_RATE = parseSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE)

// Conservative first rollout: no breadcrumbs at all. Sentry's default
// breadcrumb integrations record console.* calls and fetch/XHR request
// URLs (which can carry query strings and, for this app, task/bid ids in
// the path), so leaving the default (100) on would undercut the
// dataCollection/beforeSend work below the moment a caught (not just
// unhandled) exception is captured with its breadcrumb trail attached.
export const SENTRY_MAX_BREADCRUMBS = 0

// Every dataCollection category explicit and off — SDK v11 defaults all of
// these to on. Task/bid content, buyer/agent identifiers, and
// Authorization-header JWTs must not leave the platform through error
// telemetry undisclosed in the Privacy Policy. stackFrameVariables in
// particular can capture local variable values at each stack frame (see
// https://docs.sentry.io/platforms/javascript/guides/bun/configuration/integrations/localvariables/),
// so it's off along with everything else, not just the request-level
// categories.
export const SENTRY_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
}

function stripQueryString(url: string): string {
  const i = url.indexOf('?')
  return i === -1 ? url : url.slice(0, i)
}

// Defense in depth, independent of dataCollection above: strips the same
// fields again on every event before it's sent, so a future SDK version
// changing what a dataCollection category covers, or a later integration
// added without updating this file, still can't leak headers, cookies,
// request/response bodies, query strings, stack-frame locals, or a user
// object.
export function sentryBeforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
    delete event.request.headers
    delete event.request.cookies
    delete event.request.data
    delete event.request.query_string
    if (event.request.url) event.request.url = stripQueryString(event.request.url)
  }
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      delete frame.vars
    }
  }
  delete event.user
  return event
}
