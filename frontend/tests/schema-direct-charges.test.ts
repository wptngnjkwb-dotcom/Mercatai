import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const migration = readFileSync(join(ROOT, 'frontend/sql/21_direct_charges.sql'), 'utf8')
const compose = readFileSync(join(ROOT, 'deploy/docker-compose.yml'), 'utf8')
const createIntent = readFileSync(join(ROOT, 'frontend/app/api/v1/payments/create-intent/route.ts'), 'utf8')
const checkout = readFileSync(join(ROOT, 'frontend/components/PaymentCheckout.tsx'), 'utf8')
const onboardPage = readFileSync(join(ROOT, 'frontend/app/[locale]/(agent)/agent/stripe-onboard/page.tsx'), 'utf8')
const onboardStatusRoute = readFileSync(join(ROOT, 'frontend/app/api/v1/agents/[id]/stripe-onboard/route.ts'), 'utf8')

describe('migration 21 — Direct Charge object namespace', () => {
  it('adds and freezes the charge model and connected account while preserving legacy PaymentIntents', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS stripe_charge_model')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS stripe_connected_account_id')
    expect(migration).toMatch(/SET stripe_charge_model = 'destination'[\s\S]*stripe_payment_intent_id IS NOT NULL/)
    expect(migration).toContain('Stripe charge model is immutable')
    expect(migration).toContain('Stripe connected account is immutable')
    expect(migration).toContain('transactions_stripe_charge_context_check')
    expect(migration).toContain('destination charge must use the platform account namespace')
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain('COALESCE(tx.stripe_charge_model, p_charge_model)')
    expect(migration).toContain('COALESCE(tx.stripe_charge_id, p_stripe_charge_id)')
  })

  it('restricts both financial RPCs to service_role', () => {
    for (const signature of [
      'bind_payment_charge_context(UUID, TEXT, TEXT)',
      'record_payment_charge_identity_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT)',
    ]) {
      expect(migration).toContain('REVOKE ALL ON FUNCTION ' + signature + ' FROM PUBLIC, anon, authenticated')
      expect(migration).toContain('GRANT EXECUTE ON FUNCTION ' + signature + ' TO service_role')
    }
  })

  it('is mounted after migration 20 for fresh self-hosted installs', () => {
    const migration20 = compose.indexOf('37_payment_charge_transfer_identity.sql')
    const migration21 = compose.indexOf('38_direct_charges.sql')
    expect(migration20).toBeGreaterThan(-1)
    expect(migration21).toBeGreaterThan(migration20)
  })

  it('creates new PaymentIntents as Direct Charges and initializes Stripe.js in the same account namespace', () => {
    expect(createIntent).toContain('directChargeCreateOptions(agentStripeAccount')
    expect(createIntent).not.toContain('on_behalf_of: agentStripeAccount')
    expect(createIntent).not.toContain('transfer_data: { destination: agentStripeAccount }')
    expect(createIntent).toContain('application_fee_amount:')
    expect(checkout).toContain("intent.charge_model === 'direct'")
    expect(checkout).toContain('stripeAccount: intent.stripe_connected_account_id')
  })

  it('the onboarding UI actually reads and uses payment_enabled_country_codes — registration support alone must never be presented as payment support', () => {
    expect(onboardPage).toContain('payment_enabled_country_codes')
    expect(onboardPage).toContain('paymentEnabledCountryCodes')
    // Not just fetched and discarded — actually branched on for the
    // post-onboarding success message (conditional on stripeStatus.payment_enabled)
    // and the country-selector warning (conditional on paymentEnabledCountryCodes).
    expect(onboardPage).toMatch(/stripeStatus\.payment_enabled/)
    expect(onboardPage).toMatch(/has not yet enabled live payments/i)
    expect(onboardPage).toMatch(/paymentEnabledCountryCodes\.includes\(country\)/)
  })

  it('the onboarding status endpoint exposes country and payment_enabled, computed from the same gate create-intent enforces', () => {
    expect(onboardStatusRoute).toContain('isPaymentCountryEnabled')
    expect(onboardStatusRoute).toMatch(/payment_enabled:/)
    expect(onboardStatusRoute).toMatch(/country:\s*accountCountry/)
  })
})
