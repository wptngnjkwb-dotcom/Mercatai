'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'
import { CreditCard, Landmark, Loader2, ShieldCheck } from 'lucide-react'
import type { PaymentIntentResponse } from '@/lib/types'

type PaymentMethod = 'card' | 'sepa_debit'
type StripeError = { message?: string }
type StripePaymentIntent = { status: string }
type StripeElements = {
  create(type: 'payment', options?: Record<string, unknown>): { mount(target: HTMLElement): void; unmount(): void }
}
type StripeClient = {
  elements(options: Record<string, unknown>): StripeElements
  confirmPayment(options: Record<string, unknown>): Promise<{ error?: StripeError; paymentIntent?: StripePaymentIntent }>
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeClient
  }
}

let stripeScriptPromise: Promise<void> | null = null

function loadStripeScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve()
  if (stripeScriptPromise) return stripeScriptPromise

  stripeScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://js.stripe.com/v3/"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Stripe.js failed to load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://js.stripe.com/v3/'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Stripe.js failed to load'))
    document.head.appendChild(script)
  })

  return stripeScriptPromise
}

interface PaymentCheckoutProps {
  taskId: string
  buyerToken: string
  amountEur: number
  onComplete?: (state: 'authorized' | 'processing') => void
}

export default function PaymentCheckout({ taskId, buyerToken, amountEur, onComplete }: PaymentCheckoutProps) {
  const [method, setMethod] = useState<PaymentMethod>('card')
  const [intent, setIntent] = useState<PaymentIntentResponse | null>(null)
  const [stripe, setStripe] = useState<StripeClient | null>(null)
  const [elements, setElements] = useState<StripeElements | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const paymentElementHost = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!intent || !paymentElementHost.current) return
    let disposed = false
    let mountedElement: { mount(target: HTMLElement): void; unmount(): void } | null = null

    Promise.all([
      loadStripeScript(),
      fetch('/api/v1/payments/config', { cache: 'no-store' }).then(async response => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Stripe configuration failed')
        return body.publishable_key as string
      }),
    ])
      .then(([, publishableKey]) => {
        if (disposed || !window.Stripe || !paymentElementHost.current) return
        const stripeClient = window.Stripe(publishableKey)
        const stripeElements = stripeClient.elements({
          clientSecret: intent.client_secret,
          appearance: { theme: 'stripe', variables: { colorPrimary: '#4f46e5', borderRadius: '10px' } },
        })
        mountedElement = stripeElements.create('payment', { layout: 'tabs' })
        mountedElement.mount(paymentElementHost.current)
        setStripe(stripeClient)
        setElements(stripeElements)
      })
      .catch(e => { if (!disposed) setError(e instanceof Error ? e.message : 'Payment form failed to load') })

    return () => {
      disposed = true
      mountedElement?.unmount()
      setStripe(null)
      setElements(null)
    }
  }, [intent])

  const createIntent = async () => {
    if (!buyerToken) return
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/v1/payments/create-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
        body: JSON.stringify({ task_id: taskId, payment_method: method }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not start payment')
      setIntent(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start payment')
    } finally {
      setLoading(false)
    }
  }

  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    if (!stripe || !elements || !intent) return
    setConfirming(true)
    setError('')

    const returnUrl = `${window.location.origin}/buyer/dashboard?payment_return=1&task_id=${encodeURIComponent(taskId)}`
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: 'if_required',
    })

    if (result.error) {
      setError(result.error.message || 'Payment could not be confirmed')
      setConfirming(false)
      return
    }

    try {
      const statusResponse = await fetch(`/api/v1/payments/status/${taskId}`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
        cache: 'no-store',
      })
      const statusBody = await statusResponse.json()
      if (!statusResponse.ok) throw new Error(statusBody.error || 'Could not verify payment')
      if (statusBody.payment_state === 'failed') throw new Error('Payment failed')
      if (statusBody.payment_state === 'pending') {
        throw new Error('Stripe has not confirmed the payment yet. Please check the payment details and try again.')
      }
      onComplete?.(statusBody.payment_state === 'processing' ? 'processing' : 'authorized')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not verify payment')
      setConfirming(false)
    }
  }

  if (!intent) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={() => setMethod('card')}
            className={`rounded-xl border p-4 text-left ${method === 'card' ? 'border-brand-600 bg-brand-50' : 'border-gray-200'}`}>
            <CreditCard size={20} className="mb-2" />
            <span className="block font-semibold">Card</span>
            <span className="text-xs text-gray-500">Authorized now, captured after approval</span>
          </button>
          <button type="button" onClick={() => setMethod('sepa_debit')}
            className={`rounded-xl border p-4 text-left ${method === 'sepa_debit' ? 'border-brand-600 bg-brand-50' : 'border-gray-200'}`}>
            <Landmark size={20} className="mb-2" />
            <span className="block font-semibold">SEPA debit</span>
            <span className="text-xs text-gray-500">Bank debit; work starts after settlement</span>
          </button>
        </div>
        <div className="flex justify-between rounded-lg bg-gray-50 px-4 py-3">
          <span className="font-medium">Total</span>
          <span className="font-bold text-brand-700">€{amountEur.toFixed(2)}</span>
        </div>
        {method === 'sepa_debit' && (
          <p className="text-xs text-amber-700">SEPA is not an authorization hold. Settlement can take several business days; the agent starts only after Stripe confirms receipt.</p>
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="button" onClick={createIntent} disabled={!buyerToken || loading} className="btn-primary w-full justify-center">
          {loading ? <><Loader2 size={16} className="animate-spin" /> Preparing secure payment…</> : `Continue to pay €${amountEur.toFixed(2)}`}
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={confirm} className="space-y-4">
      <div ref={paymentElementHost} className="min-h-28" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={!stripe || !elements || confirming} className="btn-primary w-full justify-center">
        {confirming ? <><Loader2 size={16} className="animate-spin" /> Confirming…</> : `Confirm €${amountEur.toFixed(2)} payment`}
      </button>
      <p className="flex items-center justify-center gap-1 text-xs text-gray-400"><ShieldCheck size={13} /> Payment details are handled securely by Stripe</p>
    </form>
  )
}
