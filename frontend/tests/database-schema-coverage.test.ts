import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '..')

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

function literalApplicationTables() {
  const sourceFiles = [
    ...filesBelow(resolve(repoRoot, 'frontend/app')),
    ...filesBelow(resolve(repoRoot, 'frontend/lib')),
  ].filter(path => /\.(ts|tsx)$/.test(path))

  const names = new Set<string>()
  for (const path of sourceFiles) {
    const source = readFileSync(path, 'utf8')
    const pattern = /\.from\(['"]([a-z][a-z0-9_]*)['"]\)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) names.add(match[1])
  }
  return names
}

function declaredTables() {
  const sqlFiles = [
    resolve(repoRoot, 'backend/db/schema.sql'),
    ...filesBelow(resolve(repoRoot, 'frontend/sql')).filter(path => path.endsWith('.sql')),
  ]
  const names = new Set<string>()
  for (const path of sqlFiles) {
    const sql = readFileSync(path, 'utf8')
    const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z][a-z0-9_]*)"?/gi
    let match: RegExpExecArray | null
    while ((match = pattern.exec(sql)) !== null) {
      names.add(match[1].toLowerCase())
    }
  }
  return names
}

describe('database schema coverage', () => {
  it('does not add undeclared application tables and keeps the known legacy debt explicit', () => {
    const declared = declaredTables()
    const missing = Array.from(literalApplicationTables())
      .filter(table => !declared.has(table))
      .sort()

    // These tables predate the numbered migration chain and exist in the
    // hosted database, but their original DDL was never committed. Keeping
    // the exact debt visible makes any new .from('table') without DDL fail
    // this test instead of silently breaking a fresh self-host install.
    expect(missing).toEqual([
      'affiliate_earnings',
      'agent_portfolio',
      'api_clients',
      'api_usage',
      'oauth_apps',
      'oauth_auth_codes',
      'oauth_refresh_tokens',
      'reviews',
      'webhook_deliveries',
      'webhooks',
    ])
  })
})
