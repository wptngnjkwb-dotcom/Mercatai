import { describe, expect, it, vi } from 'vitest'
import {
  bindDirectChargeContext,
  directChargeCreateOptions,
  paymentContextFromTransaction,
  stripeRequestOptions,
} from '@/lib/server/stripePaymentContext'

describe('Stripe payment object namespace', () => {
  it('keeps legacy rows in the platform account and Direct Charges in the frozen connected account', () => {
    expect(paymentContextFromTransaction({ stripe_charge_model: null })).toEqual({
      chargeModel: 'destination', connectedAccountId: null,
    })
    expect(paymentContextFromTransaction({
      stripe_charge_model: 'direct', stripe_connected_account_id: 'acct_agent_1',
    })).toEqual({ chargeModel: 'direct', connectedAccountId: 'acct_agent_1' })

    expect(stripeRequestOptions({ chargeModel: 'destination', connectedAccountId: null }, 'legacy-key'))
      .toEqual({ idempotencyKey: 'legacy-key' })
    expect(directChargeCreateOptions('acct_agent_1', 'direct-key'))
      .toEqual({ stripeAccount: 'acct_agent_1', idempotencyKey: 'direct-key' })
  })

  it('rejects a malformed Direct Charge row rather than accidentally querying the platform namespace', () => {
    expect(() => paymentContextFromTransaction({ stripe_charge_model: 'direct', stripe_connected_account_id: null }))
      .toThrow(/no valid connected-account context/i)
    expect(() => paymentContextFromTransaction({ stripe_charge_model: 'future_model' }))
      .toThrow(/unknown Stripe charge model/i)
    expect(() => paymentContextFromTransaction({
      stripe_charge_model: 'destination', stripe_connected_account_id: 'acct_should_not_be_here',
    })).toThrow(/unexpected connected-account context/i)
    expect(() => paymentContextFromTransaction({ stripe_charge_model: 'direct', stripe_connected_account_id: 'not-an-account' }))
      .toThrow(/no valid connected-account context/i)
  })

  it('binds the account namespace through the database RPC and verifies the returned values', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ stripe_charge_model: 'direct', stripe_connected_account_id: 'acct_agent_1' }], error: null,
    }))
    const result = await bindDirectChargeContext({ rpc } as any, 'tx-1', 'acct_agent_1')
    expect(result).toEqual({ chargeModel: 'direct', connectedAccountId: 'acct_agent_1' })
    expect(rpc).toHaveBeenCalledWith('bind_payment_charge_context', {
      p_transaction_id: 'tx-1', p_charge_model: 'direct', p_stripe_connected_account_id: 'acct_agent_1',
    })
  })

  it('fails closed when the context RPC errors or confirms a different account', async () => {
    await expect(bindDirectChargeContext({
      rpc: vi.fn(async () => ({ data: null, error: { message: 'database unavailable' } })),
    } as any, 'tx-1', 'acct_agent_1')).rejects.toThrow(/database unavailable/i)

    await expect(bindDirectChargeContext({
      rpc: vi.fn(async () => ({
        data: [{ stripe_charge_model: 'direct', stripe_connected_account_id: 'acct_other' }], error: null,
      })),
    } as any, 'tx-1', 'acct_agent_1')).rejects.toThrow(/not confirmed/i)
  })
})
