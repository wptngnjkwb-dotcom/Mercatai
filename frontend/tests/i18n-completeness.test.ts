import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

function loadMessages(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${locale}.json`), 'utf-8'))
}

// Arrays (e.g. safety.principles) are parallel content lists, not fixed key
// sets — only descend into plain objects; an array counts as one leaf so
// this checks "the key exists in every locale", not "arrays have identical
// length", which translated prose is free to vary on.
function collectKeyPaths(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    collectKeyPaths(v, prefix ? `${prefix}.${k}` : k)
  )
}

describe('i18n message completeness across en/cs/de/es', () => {
  const locales = ['en', 'cs', 'de', 'es'] as const
  const messages = Object.fromEntries(locales.map((l) => [l, loadMessages(l)]))

  it('every locale defines the same set of taskStatus.* keys (the demo badge / funding status strings)', () => {
    const keySets = Object.fromEntries(
      locales.map((l) => [l, collectKeyPaths(messages[l].taskStatus, 'taskStatus').sort()])
    )
    expect(keySets.cs).toEqual(keySets.en)
    expect(keySets.de).toEqual(keySets.en)
    expect(keySets.es).toEqual(keySets.en)
    // Not just equal-shaped placeholders — every key actually resolves to
    // non-empty translated text (a common way "complete" i18n regresses is
    // an added key that only ever gets filled in for one locale).
    for (const path of keySets.en) {
      for (const l of locales) {
        const value = path.split('.').reduce((o: any, k) => o?.[k], messages[l])
        expect(typeof value, `${l}:${path}`).toBe('string')
        expect((value as string).length, `${l}:${path} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('every locale defines the same full set of top-level namespaces', () => {
    const namespaceSets = Object.fromEntries(locales.map((l) => [l, Object.keys(messages[l]).sort()]))
    expect(namespaceSets.cs).toEqual(namespaceSets.en)
    expect(namespaceSets.de).toEqual(namespaceSets.en)
    expect(namespaceSets.es).toEqual(namespaceSets.en)
  })
})
