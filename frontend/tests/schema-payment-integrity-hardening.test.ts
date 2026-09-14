import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const migration = readFileSync(resolve(root, 'frontend/sql/17_payment_integrity_hardening.sql'), 'utf8')
const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')
const createIntentRoute = readFileSync(resolve(root, 'frontend/app/api/v1/payments/create-intent/route.ts'), 'utf8')
const refundRoute = readFileSync(resolve(root, 'frontend/app/api/v1/payments/refund/[taskId]/route.ts'), 'utf8')
const slaRefundRoute = readFileSync(resolve(root, 'frontend/app/api/cron/sla-refund/route.ts'), 'utf8')
const adminResolveRoute = readFileSync(resolve(root, 'frontend/app/api/v1/admin/resolve/[taskId]/route.ts'), 'utf8')

describe('migration 17 payment-integrity boundaries', () => {
  it('is mounted after atomic delivery for every fresh self-hosted install', () => {
    const delivery = compose.indexOf('33_atomic_task_delivery.sql')
    const hardening = compose.indexOf('34_payment_integrity_hardening.sql')
    expect(delivery).toBeGreaterThan(-1)
    expect(hardening).toBeGreaterThan(delivery)
  })

  it('enforces one active payment, one accepted bid and stable Stripe idempotency', () => {
    expect(migration).toContain('uq_transactions_one_active_per_task')
    expect(migration).toMatch(/WHERE escrow_status IN \('pending', 'held'\)/)
    expect(migration).toContain('uq_bids_one_accepted_per_task')
    expect(migration).toContain('uq_transactions_payment_attempt_key')
    expect(migration).toContain('uq_transactions_stripe_payment_intent')
    expect(createIntentRoute).toContain('db.rpc(\'claim_task_payment\'')
    expect(createIntentRoute).toContain('idempotencyKey: `mercatai-payment-${paymentTx.payment_attempt_key}`')
  })

  it('binds delivery and finalization to the same agent, buyer and transaction', () => {
    const delivery = migration.match(/CREATE OR REPLACE FUNCTION submit_funded_task_delivery[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    const finalization = migration.match(/CREATE OR REPLACE FUNCTION finalize_funded_task[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? ''
    expect(delivery).toContain('v_transaction.agent_id IS DISTINCT FROM v_task.assigned_agent_id')
    expect(delivery).toContain('v_transaction.buyer_org_id IS DISTINCT FROM v_task.posted_by_org_id')
    expect(finalization).toContain('v_tx.agent_id IS DISTINCT FROM v_task.assigned_agent_id')
    expect(finalization).toContain('v_tx.buyer_org_id IS DISTINCT FROM v_task.posted_by_org_id')
    expect(finalization).toContain("v_task.status = 'completed' AND v_tx.escrow_status = 'released'")
    expect(finalization).toContain('newly_completed BOOLEAN')
  })

  it('keeps all financial RPCs unavailable to public roles', () => {
    for (const signature of [
      'accept_task_bid(UUID, UUID)',
      'claim_task_payment(UUID, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC)',
      'submit_funded_task_delivery(UUID, UUID, TEXT)',
      'invalidate_task_funding(UUID, UUID)',
      'finalize_funded_task(UUID, UUID, TEXT)',
      'create_store_hire(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT)',
      'finalize_task_refund(UUID, UUID, TEXT, TEXT)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`)
    }
  })

  it('routes every refund/dispute outcome through atomic DB finalization and stable Stripe retry keys', () => {
    expect(refundRoute).toContain("db.rpc('finalize_task_refund'")
    expect(refundRoute).toContain('idempotencyKey: `mercatai-refund-${tx.id}`')
    expect(slaRefundRoute).toContain("db.rpc('finalize_task_refund'")
    expect(slaRefundRoute).toContain('idempotencyKey: `mercatai-sla-refund-${tx.id}`')
    expect(adminResolveRoute).toContain("db.rpc('finalize_task_refund'")
    expect(adminResolveRoute).toContain("db.rpc('finalize_funded_task'")
    expect(adminResolveRoute).toContain('idempotencyKey: `mercatai-admin-refund-${tx.id}`')
  })
})
