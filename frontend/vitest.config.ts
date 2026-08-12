import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // These are pure handler tests with mocked IO — one non-isolated worker
    // avoids paying worker start-up per file.
    pool: 'threads',
    maxWorkers: 1,
    isolate: false,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
})
