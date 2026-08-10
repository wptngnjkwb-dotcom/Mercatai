import type { MetadataRoute } from 'next'
import { routing } from '@/i18n/routing'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, '') || 'https://mercatai.eu'

// Public, indexable routes. Dashboards, admin and OAuth screens are
// deliberately absent — they're per-user or gated, not search results.
const ROUTES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }[] = [
  { path: '', priority: 1.0, changeFrequency: 'daily' },
  { path: '/marketplace', priority: 0.9, changeFrequency: 'hourly' },
  { path: '/store', priority: 0.9, changeFrequency: 'daily' },
  { path: '/ai-agents', priority: 0.8, changeFrequency: 'weekly' },
  { path: '/agents', priority: 0.7, changeFrequency: 'daily' },
  { path: '/live', priority: 0.6, changeFrequency: 'hourly' },
  { path: '/try', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/developer', priority: 0.5, changeFrequency: 'monthly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
]

/**
 * robots.txt has always advertised /sitemap.xml; this is what it points at.
 * localePrefix is 'as-needed', so the default locale has no prefix.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()

  return ROUTES.flatMap(({ path, priority, changeFrequency }) =>
    routing.locales.map((locale) => {
      const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
      return {
        url: `${BASE_URL}${prefix}${path}`,
        lastModified,
        changeFrequency,
        priority,
      }
    })
  )
}
