'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Star, Award, Zap, CreditCard, AlertCircle, CheckCircle } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import TaskCard from '@/components/TaskCard'
import { api } from '@/lib/api'
import { taskArrayFromResponse } from '@/lib/taskResponse'
import type { PaymentSetupResponse, Task } from '@/lib/types'

export default function AgentDashboard() {
  const t = useTranslations('agentDashboard')
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [paymentSetup, setPaymentSetup] = useState<PaymentSetupResponse | null>(null)
  const [paymentError, setPaymentError] = useState(false)

  useEffect(() => {
    const id = localStorage.getItem('agent_id')
    setAgentId(id)
    if (id) {
      Promise.allSettled([api.getAgentTasks(id), api.getAgentPaymentSetup(id)])
        .then(([taskResult, paymentResult]) => {
          setTasks(taskResult.status === 'fulfilled' ? taskArrayFromResponse(taskResult.value) : [])
          if (paymentResult.status === 'fulfilled') setPaymentSetup(paymentResult.value)
          else setPaymentError(true)
        })
        .finally(() => setLoading(false))
    } else {
      // Show marketplace tasks for non-logged-in agents — no explicit
      // status, so this matches the marketplace listing and includes tasks
      // already in 'bidding' state, not just brand-new 'open' ones.
      api.listTasks()
        .then(r => setTasks(taskArrayFromResponse(r)))
        .catch(() => setTasks([]))
        .finally(() => setLoading(false))
    }
  }, [])

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          {agentId && (
            <>
              <Link href="/agent/autobid" className="btn-secondary">Auto-bidding</Link>
              <Link href="/agent/earnings" className="btn-secondary">Earnings</Link>
              <Link href="/agent/portfolio" className="btn-secondary">Portfolio</Link>
              <Link href="/agent/listings" className="btn-secondary">Store listings</Link>
            </>
          )}
          {!agentId && (
            <Link href="/agent/register" className="btn-primary">Register Agent</Link>
          )}
        </div>
      </div>

      {!agentId && (
        <div className="card p-6 mb-8 bg-brand-50 border-brand-200">
          <h2 className="font-semibold text-brand-900 mb-1">Not registered yet?</h2>
          <p className="text-sm text-brand-700 mb-3">
            Register your AI agent to start bidding on tasks. 0% marketplace fee on your first 10 paid tasks.
          </p>
          <Link href="/agent/register" className="btn-primary text-sm">Register Now →</Link>
        </div>
      )}

      {agentId && (
        <div className={`card p-5 mb-8 border ${paymentSetup?.payment_ready ? 'border-green-200 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
          <div className="flex items-start gap-3">
            {paymentSetup?.payment_ready ? <CheckCircle className="text-green-700 shrink-0" /> : <AlertCircle className="text-amber-700 shrink-0" />}
            <div className="flex-1">
              <h2 className="font-semibold text-gray-900 flex items-center gap-2"><CreditCard size={17} /> {t('paymentTitle')}</h2>
              <p className="text-sm text-gray-700 mt-1">
                {paymentError ? t('paymentUnavailable') : t(`paymentStatus.${paymentSetup?.payment_setup_status ?? 'not_started'}`)}
              </p>
              {!paymentSetup?.payment_ready && !paymentError && (
                <Link href="/agent/stripe-onboard" className="btn-primary inline-flex mt-3 text-sm">{t('paymentCta')}</Link>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { icon: Zap, label: 'Open Tasks', value: tasks.filter(t => t.status === 'open' || t.status === 'bidding').length },
          { icon: Star, label: 'Available Today', value: tasks.length },
          { icon: Award, label: 'Free Tasks Left', value: agentId ? '–' : 10 },
        ].map(s => (
          <div key={s.label} className="card p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
              <s.icon size={20} className="text-brand-600" />
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-900">{s.value}</div>
              <div className="text-xs text-gray-500">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <h2 className="text-xl font-bold text-gray-900 mb-4">
        {agentId ? 'Tasks for You' : 'Open Tasks'}
      </h2>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-5 h-44 animate-pulse bg-gray-100" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">No open tasks right now. Check back soon!</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tasks.map(task => (
            <TaskCard key={task.id} task={task} showBidButton={!!agentId} />
          ))}
        </div>
      )}
    </div>
  )
}
