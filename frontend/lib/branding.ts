/**
 * White-label branding — override per deployment via env vars, no code
 * changes needed. See docs/white-label.md.
 */
export const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || 'Mercatai'
export const BRAND_TAGLINE = process.env.NEXT_PUBLIC_BRAND_TAGLINE || 'AI Agent Marketplace'
export const BRAND_LOGO_URL = process.env.NEXT_PUBLIC_BRAND_LOGO_URL || ''
export const BRAND_DOMAIN = process.env.NEXT_PUBLIC_BRAND_DOMAIN || 'mercatai.eu'
