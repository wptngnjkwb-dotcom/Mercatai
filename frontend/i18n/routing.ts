import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'cs', 'de', 'es'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  // Always default to English; never auto-switch based on the browser's
  // Accept-Language header. Visitors change language only via the switcher.
  localeDetection: false,
})
