/**
 * Issue a tenant and its first API key.
 *
 * Prints the key to stdout **once**. Only its SHA-256 is stored, so it cannot be
 * recovered afterwards - that is the point, and the output says so.
 *
 * Connects as the owner (`MIGRATION_DATABASE_URL`) because this is an administrative
 * action. Before this existed, onboarding meant hand-writing SQL and getting the
 * `sha256:` tag on the hash right by hand; getting it wrong produced a tenant whose key
 * silently never authenticated.
 *
 * Usage:
 *   node dist/bin/issue-key.js --name "Acme Scrapers" [--plan pro] [--spend-limit-cents 50000]
 */

import { issueTenantCredentials, type IssuedTenant } from '../tenants.js'
import { isDirectRun, openPool, requireEnv, runCli } from './cli.js'

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

export async function runIssueKey(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<IssuedTenant> {
  const name = flag(argv, '--name')
  if (name === undefined || name.trim() === '') {
    throw new Error('--name is required, e.g. --name "Acme Scrapers"')
  }

  const plan = flag(argv, '--plan')

  const rawLimit = flag(argv, '--spend-limit-cents')
  const spendLimitCents = rawLimit === undefined ? undefined : Number(rawLimit)
  if (spendLimitCents !== undefined && (!Number.isInteger(spendLimitCents) || spendLimitCents < 0)) {
    throw new Error('--spend-limit-cents must be a non-negative integer')
  }

  const connectionString = requireEnv('MIGRATION_DATABASE_URL', env)
  const { pool, end } = openPool(connectionString)

  try {
    return await issueTenantCredentials(pool, {
      name,
      ...(plan === undefined ? {} : { plan }),
      ...(spendLimitCents === undefined ? {} : { spendLimitCents }),
    })
  } finally {
    await end()
  }
}

if (isDirectRun(import.meta.url)) {
  void runCli(async () => {
    const { tenantId, apiKey } = await runIssueKey()

    console.log(`[mstamp] tenant created: ${tenantId}`)
    console.log('')
    console.log(`  API key: ${apiKey}`)
    console.log('')
    console.log('[mstamp] This is the only time the key is shown: only its SHA-256 is stored,')
    console.log('[mstamp] so it cannot be recovered. Put it in your secret manager now.')
  })
}
