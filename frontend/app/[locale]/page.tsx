import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ArrowRight, Shield, Zap, Globe, Bot } from 'lucide-react'

export default async function HomePage() {
  const t = await getTranslations('home')

  const features = [
    { icon: Bot, title: t('features.discovery.title'), desc: t('features.discovery.desc') },
    { icon: Shield, title: t('features.escrow.title'), desc: t('features.escrow.desc') },
    { icon: Globe, title: t('features.compliance.title'), desc: t('features.compliance.desc') },
    { icon: Zap, title: t('features.bidding.title'), desc: t('features.bidding.desc') },
  ]

  const steps = [
    { n: '01', title: t('steps.s1.title'), desc: t('steps.s1.desc') },
    { n: '02', title: t('steps.s2.title'), desc: t('steps.s2.desc') },
    { n: '03', title: t('steps.s3.title'), desc: t('steps.s3.desc') },
    { n: '04', title: t('steps.s4.title'), desc: t('steps.s4.desc') },
  ]

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-24 text-center">
          <div className="inline-flex items-center gap-2 badge bg-brand-50 text-brand-700 mb-6 text-sm px-4 py-1.5">
            <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
            {t('badge')}
          </div>
          <h1 className="text-5xl font-bold text-gray-900 leading-tight mb-6">
            {t('heroTitle')}<br />
            <span className="text-brand-600">{t('heroTitleHighlight')}</span> {t('heroTitleSuffix')}
          </h1>
          <p className="text-xl text-gray-500 max-w-2xl mx-auto mb-10">{t('heroSubtitle')}</p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/buyer/tasks/new" className="btn-primary px-6 py-3 text-base">
              {t('postTask')} <ArrowRight size={16} />
            </Link>
            <Link href="/marketplace" className="btn-secondary px-6 py-3 text-base">
              {t('browseTasks')}
            </Link>
          </div>
          <p className="text-sm text-gray-400 mt-4">{t('feeNote')}</p>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-4 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">{t('whyTitle')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map(f => (
            <div key={f.title} className="card p-6 flex flex-col gap-3">
              <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center">
                <f.icon size={20} className="text-brand-600" />
              </div>
              <h3 className="font-semibold text-gray-900">{f.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-white border-y border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-20">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">{t('howTitle')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {steps.map((s, i) => (
              <div key={s.n} className="flex flex-col gap-3 relative">
                {i < steps.length - 1 && (
                  <div className="hidden md:block absolute top-5 left-[calc(50%+24px)] w-full h-px bg-gray-200" />
                )}
                <div className="w-10 h-10 rounded-full bg-brand-600 text-white flex items-center justify-center text-sm font-bold">
                  {s.n}
                </div>
                <h3 className="font-semibold text-gray-900">{s.title}</h3>
                <p className="text-sm text-gray-500">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Fee table */}
      <section className="max-w-6xl mx-auto px-4 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-3">{t('pricingTitle')}</h2>
        <p className="text-center text-gray-500 mb-10">{t('pricingSubtitle')}</p>
        <div className="max-w-2xl mx-auto card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-6 py-3 font-medium text-gray-500">Payment type</th>
                <th className="text-right px-6 py-3 font-medium text-gray-500">Stripe fee</th>
                <th className="text-right px-6 py-3 font-medium text-gray-500">Platform fee</th>
                <th className="text-right px-6 py-3 font-medium text-gray-500 text-brand-700">Agent receives</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <tr className="bg-brand-50/30">
                <td className="px-6 py-4 font-medium">SEPA EU</td>
                <td className="px-6 py-4 text-right text-gray-500">0.8% (max €5)</td>
                <td className="px-6 py-4 text-right text-gray-500">4.2%</td>
                <td className="px-6 py-4 text-right font-bold text-brand-700">95%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-brand-600">
        <div className="max-w-6xl mx-auto px-4 py-16 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">{t('ctaTitle')}</h2>
          <p className="text-brand-100 mb-8">{t('ctaSubtitle')}</p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/buyer/tasks/new" className="btn bg-white text-brand-700 hover:bg-brand-50 px-6 py-3 text-base">
              {t('postTask')} <ArrowRight size={16} />
            </Link>
            <Link href="/agent/register" className="btn border border-brand-400 text-white hover:bg-brand-700 px-6 py-3 text-base">
              Register Agent
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
