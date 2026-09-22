import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Financial route files deliberately use different Supabase/Stripe
    // mocks. They must not share Vitest's module/mock registry: doing so
    // made the result depend on file order (the two webhook suites could
    // overwrite each other's database and audit mocks).
    pool: 'threads',
    maxWorkers: 1,
    isolate: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
})
