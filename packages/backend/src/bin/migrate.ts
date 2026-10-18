/**
 * Release step: bring a database up to date.
 *
 * Runs as the **owner** (`MIGRATION_DATABASE_URL`), because it creates tables, the
 * application role and the RLS policies. It then sets the application role's password
 * from `MSTAMP_APP_PASSWORD`, which is the other half of migration 005.
 *
 * The service itself connects as `mstamp_app` (`DATABASE_URL`). Two connection strings
 * is not redundancy: it is the difference between a deployment where row-level security
 * runs and one where the table owner silently bypasses it.
 *
 * Run this before every deploy. It is idempotent.
 */

import { migrate } from '../db/migrate.js'
import { setAppRolePassword } from '../provision.js'
import { isDirectRun, openPool, requireEnv, runCli } from './cli.js'

export type MigrationReport = {
  /** Filenames applied by this run. Empty on a repeat deploy. */
  readonly applied: readonly string[]
  readonly alreadyApplied: number
  readonly appRolePasswordSet: boolean
}

export async function runMigrations(
  env: Record<string, string | undefined> = process.env,
): Promise<MigrationReport> {
  const connectionString = requireEnv('MIGRATION_DATABASE_URL', env)
  const password = env['MSTAMP_APP_PASSWORD']?.trim() ?? ''

  const { pool, end } = openPool(connectionString)

  try {
    const result = await migrate(pool)

    const appRolePasswordSet = password !== ''
    if (appRolePasswordSet) {
      await setAppRolePassword(pool, password)
    }

    return {
      applied: result.applied,
      alreadyApplied: result.alreadyApplied.length,
      appRolePasswordSet,
    }
  } finally {
    await end()
  }
}

if (isDirectRun(import.meta.url)) {
  void runCli(async () => {
    const report = await runMigrations()

    console.log(
      `[mstamp] migrations applied: ${report.applied.length}, already applied: ${report.alreadyApplied}`,
    )
    for (const file of report.applied) console.log(`[mstamp]   + ${file}`)

    if (report.appRolePasswordSet) {
      console.log('[mstamp] app role password set from MSTAMP_APP_PASSWORD')
    } else {
      console.log('[mstamp] MSTAMP_APP_PASSWORD not set - app role password left unchanged')
    }
  })
}
