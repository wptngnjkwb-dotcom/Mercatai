export const STORE_PRICING_MODES = ['fixed'] as const
export type StorePricingMode = typeof STORE_PRICING_MODES[number]

export const STORE_OUTPUT_FORMATS = [
  'csv',
  'xlsx',
  'json',
  'pdf',
  'docx',
  'markdown',
  'plain_text',
  'html',
  'source_code',
  'other',
] as const
export type StoreOutputFormat = typeof STORE_OUTPUT_FORMATS[number]

export interface StoreListingTerms {
  pricing_mode: StorePricingMode
  included_items: string[]
  required_inputs: string[]
  output_formats: StoreOutputFormat[]
  revision_count: number
}

function parseTextList(value: unknown, field: string, maxItems: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of text values`)
  if (value.length > maxItems) throw new Error(`${field} may contain at most ${maxItems} items`)

  const normalized = value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${field} must contain only text values`)
    const text = item.trim()
    if (text.length < 1 || text.length > 200) {
      throw new Error(`${field} items must be between 1 and 200 characters`)
    }
    return text
  })

  if (new Set(normalized.map(item => item.toLocaleLowerCase('en-US'))).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`)
  }
  return normalized
}

export function parseStoreListingTerms(body: Record<string, unknown>): StoreListingTerms {
  const pricingMode = body.pricing_mode ?? 'fixed'
  if (typeof pricingMode !== 'string' || !STORE_PRICING_MODES.includes(pricingMode as StorePricingMode)) {
    throw new Error('pricing_mode must be fixed')
  }

  const revisionCount = body.revision_count ?? 0
  if (!Number.isInteger(revisionCount) || Number(revisionCount) < 0 || Number(revisionCount) > 10) {
    throw new Error('revision_count must be an integer between 0 and 10')
  }

  const includedItems = parseTextList(body.included_items, 'included_items', 20)
  const requiredInputs = parseTextList(body.required_inputs, 'required_inputs', 20)
  const rawOutputFormats = parseTextList(body.output_formats, 'output_formats', 10)
  const invalidFormat = rawOutputFormats.find(format => !STORE_OUTPUT_FORMATS.includes(format as StoreOutputFormat))
  if (invalidFormat) {
    throw new Error(`output_formats contains unsupported value: ${invalidFormat}`)
  }

  return {
    pricing_mode: pricingMode as StorePricingMode,
    included_items: includedItems,
    required_inputs: requiredInputs,
    output_formats: rawOutputFormats as StoreOutputFormat[],
    revision_count: Number(revisionCount),
  }
}

export function storeListingTermsText(terms: StoreListingTerms): string[] {
  return [
    ...terms.included_items,
    ...terms.required_inputs,
    ...terms.output_formats,
  ]
}
