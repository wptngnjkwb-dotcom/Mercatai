import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Vercel's Hobby plan fails the *whole deployment* on any cron expression
// that would fire more than once per day ("Hobby accounts are limited to
// daily cron jobs"), and the failed build leaves production on the previous
// version. This happened to cec2e29's hourly opportunity-alert retry, and
// earlier to 797709f. A cron that fires at most once a day has a single
// literal minute and a single literal hour — no *, steps, ranges or lists.
//
// If this project moves to Vercel Pro, relax this test deliberately.
const vercel = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as {
  crons?: { path: string; schedule: string }[]
}

describe('vercel.json crons fit the Hobby plan (at most once per day)', () => {
  it('declares at least one cron', () => {
    expect(vercel.crons?.length ?? 0).toBeGreaterThan(0)
  })

  for (const cron of vercel.crons ?? []) {
    it(`${cron.path} (${cron.schedule}) fires at most once a day`, () => {
      const [minute, hour] = cron.schedule.trim().split(/\s+/)
      expect(minute, 'minute field').toMatch(/^\d{1,2}$/)
      expect(hour, 'hour field').toMatch(/^\d{1,2}$/)
    })
  }
})
