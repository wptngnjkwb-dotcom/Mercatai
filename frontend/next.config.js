/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: '/.well-known/agent.json', destination: '/api/discovery/agent-json' },
    ]
  },
}

module.exports = nextConfig
