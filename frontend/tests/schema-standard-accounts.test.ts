import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LEGACY_EXPRESS_PILOT_TASK_IDS,
  isLegacyExpressPilotTask,
  stripeAccountMatchesRequirement,
  stripeAccountFields,
} from '@/lib/server/stripeAccountRequirement'

const ROOT = join(__dirname, '..', '..')
const migration = readFileSync(join(ROOT, 'frontend/sql/24_standard_accounts_and_pilot_express.sql'), 'utf8')
const schema = readFileSync(join(ROOT, 'backend/db/schema.sql'), 'utf8')
const compose = readFileSync(join(ROOT, 'deploy/docker-compose.yml'), 'utf8')

const expectedPilots = [
  'e427ab6c-62fa-473f-8e84-93003b13a47f',
  '49a315bc-70ea-409d-b46d-d60ac369e23a',
  '2ee876c6-ebc7-489e-b138-306ecdb32eaf',
]

describe('migration 24 — Standard by default, exactly three Express pilots', () => {
  it('uses separate Standard fields and never overwrites the legacy Express account', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS stripe_standard_account_id TEXT/)
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS stripe_standard_onboarding_completed BOOLEAN NOT NULL DEFAULT false/)
    expect(migration).not.toMatch(/SET\s+stripe_account_id\s*=/)
  })

  it('enforces the exact pilot allowlist in both application and database sources of truth', () => {
    expect(Array.from(LEGACY_EXPRESS_PILOT_TASK_IDS)).toEqual(expectedPilots)
    for (const id of expectedPilots) {
      expect(isLegacyExpressPilotTask(id)).toBe(true)
      expect(migration).toContain(`'${id}'::uuid`)
      expect(schema).toContain(`'${id}'::uuid`)
    }
    expect(isLegacyExpressPilotTask('11111111-1111-1111-1111-111111111111')).toBe(false)
    expect(migration).toContain('tasks_legacy_express_pilot_only_check')
  })

  it('maps ordinary onboarding to Standard and the legacy exception to Express', () => {
    expect(stripeAccountFields('standard_agent_liability')).toMatchObject({
      accountId: 'stripe_standard_account_id',
      stripeType: 'standard',
      feePayer: 'stripe',
      lossesCollector: 'stripe',
    })
    expect(stripeAccountFields('legacy_express_platform_liability')).toMatchObject({
      accountId: 'stripe_account_id',
      stripeType: 'express',
      feePayer: 'application',
      lossesCollector: 'application',
    })
  })

  it('accepts the real Stripe v1 controller values for Express and Standard accounts', () => {
    expect(stripeAccountMatchesRequirement({
      type: 'express',
      controller: {
        type: 'application',
        fees: { payer: 'application_express' },
        losses: { payments: 'application' },
      },
    } as any, 'legacy_express_platform_liability')).toBe(true)

    expect(stripeAccountMatchesRequirement({
      type: 'standard',
      controller: {
        type: 'account',
        fees: { payer: 'account' },
        losses: { payments: 'stripe' },
      },
    } as any, 'standard_agent_liability')).toBe(true)
  })

  it('still rejects controller values that would change who bears fees or losses', () => {
    expect(stripeAccountMatchesRequirement({
      type: 'express',
      controller: {
        type: 'application',
        fees: { payer: 'account' },
        losses: { payments: 'application' },
      },
    } as any, 'legacy_express_platform_liability')).toBe(false)

    expect(stripeAccountMatchesRequirement({
      type: 'standard',
      controller: {
        type: 'application',
        fees: { payer: 'application' },
        losses: { payments: 'stripe' },
      },
    } as any, 'standard_agent_liability')).toBe(false)

    expect(stripeAccountMatchesRequirement({
      type: 'standard',
      controller: {
        type: 'account',
        fees: { payer: 'account' },
        losses: { payments: 'application' },
      },
    } as any, 'standard_agent_liability')).toBe(false)
  })

  it('freezes the responsibility model through a service-role-only RPC', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION bind_payment_charge_context_v2/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION bind_payment_charge_context_v2\(UUID, TEXT, TEXT, TEXT\)\s+FROM PUBLIC, anon, authenticated/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION bind_payment_charge_context_v2\(UUID, TEXT, TEXT, TEXT\)\s+TO service_role/)
  })

  it('is mounted after migration 23 for fresh self-hosted installs', () => {
    const lines = compose.split('\n')
    const previous = lines.findIndex((line) => line.includes('23_opportunity_alerts.sql'))
    const current = lines.findIndex((line) => line.includes('24_standard_accounts_and_pilot_express.sql'))
    expect(current).toBeGreaterThan(previous)
  })
})
