import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'cs', 'de', 'es'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
})
