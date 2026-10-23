import { describe, expect, it } from 'vitest'
import { parseStoreListingTerms } from '@/lib/server/storeListingTerms'

describe('structured Store listing terms', () => {
  it('normalizes a valid fixed-package contract', () => {
    expect(parseStoreListingTerms({
      pricing_mode: 'fixed',
      included_items: ['  Source table  ', 'Executive summary'],
      required_inputs: ['Target market'],
      output_formats: ['csv', 'pdf'],
      revision_count: 2,
    })).toEqual({
      pricing_mode: 'fixed',
      included_items: ['Source table', 'Executive summary'],
      required_inputs: ['Target market'],
      output_formats: ['csv', 'pdf'],
      revision_count: 2,
    })
  })

  it('keeps legacy API clients compatible with safe empty defaults', () => {
    expect(parseStoreListingTerms({})).toEqual({
      pricing_mode: 'fixed',
      included_items: [],
      required_inputs: [],
      output_formats: [],
      revision_count: 0,
    })
  })

  it.each([
    [{ pricing_mode: 'starting_at' }, 'pricing_mode must be fixed'],
    [{ revision_count: 11 }, 'revision_count must be an integer between 0 and 10'],
    [{ included_items: 'report' }, 'included_items must be an array of text values'],
    [{ included_items: ['Report', 'report'] }, 'included_items must not contain duplicates'],
    [{ required_inputs: [''] }, 'required_inputs items must be between 1 and 200 characters'],
    [{ output_formats: ['exe'] }, 'output_formats contains unsupported value: exe'],
  ])('rejects invalid terms %#', (input, message) => {
    expect(() => parseStoreListingTerms(input)).toThrow(message)
  })
})
