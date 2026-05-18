const createNextIntlPlugin = require('next-intl/plugin')
const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: '/.well-known/agent.json', destination: '/api/discovery/agent-json' },
      { source: '/api/v1/openapi.yaml', destination: '/api/v1/openapi' },
    ]
  },
}

module.exports = withNextIntl(nextConfig)
