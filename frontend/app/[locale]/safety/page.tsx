import { getTranslations } from 'next-intl/server'

interface TitledItem {
  title: string
  description: string
}

export default async function SafetyPage() {
  const t = await getTranslations('safety')
  const principles = t.raw('principles') as TitledItem[]
  const categories = t.raw('categories') as TitledItem[]
  const howItWorksBody = t.raw('howItWorksBody') as string[]
  const reportingBody = t.raw('reportingBody') as string[]
  const appealsBody = t.raw('appealsBody') as string[]

  return (
    <div className="max-w-3xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('title')}</h1>
      <p className="text-sm text-gray-400 mb-10">{t('updated')}</p>

      <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">

        <section>
          <p>{t('intro')}</p>
          <p className="mt-3 text-sm">
            {t('machineReadableNote')}{' '}
            <a href="/.well-known/mercatai-safety.json" className="text-brand-600 font-mono">
              /.well-known/mercatai-safety.json
            </a>
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('principlesHeading')}</h2>
          <p>{t('principlesIntro')}</p>
          <ul className="list-disc list-inside space-y-2 mt-3">
            {principles.map((p) => (
              <li key={p.title}><strong>{p.title}</strong> — {p.description}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('prohibitedHeading')}</h2>
          <p>{t('prohibitedIntro')}</p>
          <ul className="list-disc list-inside space-y-2 mt-3">
            {categories.map((c) => (
              <li key={c.title}><strong>{c.title}</strong> — {c.description}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('howItWorksHeading')}</h2>
          {howItWorksBody.map((p, i) => <p key={i} className={i > 0 ? 'mt-3' : ''}>{p}</p>)}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('reportingHeading')}</h2>
          {reportingBody.map((p, i) => <p key={i} className={i > 0 ? 'mt-3' : ''}>{p}</p>)}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('appealsHeading')}</h2>
          {appealsBody.map((p, i) => <p key={i} className={i > 0 ? 'mt-3' : ''}>{p}</p>)}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('oversightHeading')}</h2>
          <p>{t('oversightBody')}</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">{t('contactHeading')}</h2>
          <p>
            {t('contactBody')}{' '}
            <a href="mailto:mercatai@seznam.cz" className="text-brand-600">mercatai@seznam.cz</a>
          </p>
        </section>

      </div>
    </div>
  )
}
