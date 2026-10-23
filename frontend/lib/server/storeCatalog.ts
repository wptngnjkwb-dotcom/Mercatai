import { detectOffPlatformContact } from './offPlatformContact'

export const STORE_CATEGORIES = [
  'research',
  'content',
  'code_review',
  'procurement',
  'data_analysis',
  'translation',
  'finance',
] as const

export type StoreCategory = typeof STORE_CATEGORIES[number]

export const STORE_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'delivery_asc',
  'reputation_desc',
] as const

export type StoreSort = typeof STORE_SORTS[number]

export interface StoreCatalogFilters {
  agentId?: string
  category?: StoreCategory
  language?: string
  minPrice?: number
  maxPrice?: number
  maxDeliveryHours?: number
  sort: StoreSort
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGENT_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/

function optionalNumber(searchParams: URLSearchParams, name: string) {
  const raw = searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

export function parseStoreCatalogFilters(searchParams: URLSearchParams): StoreCatalogFilters {
  const category = searchParams.get('category') || undefined
  if (category && !STORE_CATEGORIES.includes(category as StoreCategory)) {
    throw new Error('category is not supported')
  }

  const agentId = searchParams.get('agent_id')?.trim() || undefined
  if (agentId && !UUID_PATTERN.test(agentId) && !AGENT_SLUG_PATTERN.test(agentId)) {
    throw new Error('agent_id must be an agent UUID or public agent ID')
  }

  const language = searchParams.get('language')?.trim() || undefined
  if (language && !LANGUAGE_PATTERN.test(language)) {
    throw new Error('language must be a two- or three-letter code, optionally followed by a country code')
  }

  const minPrice = optionalNumber(searchParams, 'min_price')
  const maxPrice = optionalNumber(searchParams, 'max_price')
  if (minPrice !== undefined && (minPrice < 1 || minPrice > 10_000)) {
    throw new Error('min_price must be between 1 and 10000')
  }
  if (maxPrice !== undefined && (maxPrice < 1 || maxPrice > 10_000)) {
    throw new Error('max_price must be between 1 and 10000')
  }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new Error('min_price cannot exceed max_price')
  }

  const maxDeliveryHours = optionalNumber(searchParams, 'max_delivery_hours')
  if (maxDeliveryHours !== undefined && (!Number.isInteger(maxDeliveryHours) || maxDeliveryHours < 1 || maxDeliveryHours > 720)) {
    throw new Error('max_delivery_hours must be an integer between 1 and 720')
  }

  const sort = searchParams.get('sort') || 'newest'
  if (!STORE_SORTS.includes(sort as StoreSort)) {
    throw new Error('sort is not supported')
  }

  return {
    ...(agentId ? { agentId } : {}),
    ...(category ? { category: category as StoreCategory } : {}),
    ...(language ? { language } : {}),
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(maxDeliveryHours !== undefined ? { maxDeliveryHours } : {}),
    sort: sort as StoreSort,
  }
}

export async function queryPublicStoreListings(db: any, filters: StoreCatalogFilters) {
  let query = db
    .from('agent_listings')
    .select('id,title,description,category,price_eur,delivery_hours,pricing_mode,included_items,required_inputs,output_formats,revision_count,hires_count,created_at,status,agents!inner(id,agent_id,display_name,languages,reputation_score,success_rate,total_tasks_completed,is_active)')
    .eq('is_active', true)
    .eq('status', 'active')
    .eq('moderation_status', 'approved')
    .eq('agents.is_active', true)
    .eq('agents.profile_visibility', 'public')

  if (filters.agentId) {
    query = UUID_PATTERN.test(filters.agentId)
      ? query.eq('agents.id', filters.agentId)
      : query.eq('agents.agent_id', filters.agentId)
  }
  if (filters.category) query = query.eq('category', filters.category)
  if (filters.language) query = query.contains('agents.languages', [filters.language])
  if (filters.minPrice !== undefined) query = query.gte('price_eur', filters.minPrice)
  if (filters.maxPrice !== undefined) query = query.lte('price_eur', filters.maxPrice)
  if (filters.maxDeliveryHours !== undefined) query = query.lte('delivery_hours', filters.maxDeliveryHours)

  const { data, error } = await query.order('created_at', { ascending: false }).limit(100)
  if (error) return { data: null, error }

  // Old rows may predate the publication-time contact policy. Keep them
  // out of every public Store surface until the agent republishes safe
  // content instead of trusting historical moderation alone.
  const listings = (data ?? []).filter((listing: any) => !detectOffPlatformContact(
    [
      listing.title,
      listing.description,
      ...(Array.isArray(listing.included_items) ? listing.included_items : []),
      ...(Array.isArray(listing.required_inputs) ? listing.required_inputs : []),
      ...(Array.isArray(listing.output_formats) ? listing.output_formats : []),
      listing.agents?.agent_id,
      listing.agents?.display_name,
    ],
    { blockExternalUrls: true },
  ).blocked)
  listings.sort((a: any, b: any) => {
    if (filters.sort === 'price_asc') return Number(a.price_eur) - Number(b.price_eur)
    if (filters.sort === 'price_desc') return Number(b.price_eur) - Number(a.price_eur)
    if (filters.sort === 'delivery_asc') return Number(a.delivery_hours) - Number(b.delivery_hours)
    if (filters.sort === 'reputation_desc') {
      const reputationDelta = Number(b.agents?.reputation_score ?? 0) - Number(a.agents?.reputation_score ?? 0)
      return reputationDelta || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  return { data: listings, error: null }
}
