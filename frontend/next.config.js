const createNextIntlPlugin = require('next-intl/plugin')
const { withSentryConfig } = require('@sentry/nextjs/config')
const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Slim runtime bundle used by the self-host Docker image (deploy/);
  // no effect on Vercel deployments.
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/.well-known/agent.json', destination: '/api/discovery/agent-json' },
      { source: '/.well-known/mercatai-safety.json', destination: '/api/discovery/safety-json' },
      { source: '/api/v1/openapi.yaml', destination: '/api/v1/openapi' },
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          {
            // Note: 'unsafe-inline'/'unsafe-eval' are required by Next.js
            // without nonce plumbing, so this is not a strict CSP — it still
            // shuts the door on scripts, frames and form posts to third-party
            // origins. Stripe's domains are allowed for the payment flow.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.js.stripe.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https: https://*.stripe.com https://link.com https://*.link.com",
              "font-src 'self' data:",
              "connect-src 'self' https://api.stripe.com https://link.com https://*.link.com https://*.supabase.co https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
              "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://link.com https://*.link.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

module.exports = withSentryConfig(withNextIntl(nextConfig), {
  // Optional — org/project/authToken are only needed to upload source maps
  // for readable stack traces. Unset (self-host, or before a Sentry project
  // exists), the build succeeds without uploading anything; only
  // NEXT_PUBLIC_SENTRY_DSN is needed to actually receive events.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.SENTRY_AUTH_TOKEN,
  webpack: { treeshake: { removeDebugLogging: true } },
})
