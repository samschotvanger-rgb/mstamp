/**
 * Scheduled step: delete expired payload previews.
 *
 * Connects as the **application** role (`DATABASE_URL`), not the owner. The delete goes
 * through a `SECURITY DEFINER` function precisely so it can cross tenants from that
 * role; without it, a plain `DELETE` as `mstamp_app` with no `app.tenant_id` matches
 * zero rows and reports success while retaining everything. See migration 004.
 *
 * Intended for a platform cron (Railway, or any scheduler) roughly once a day. It never
 * touches `receipts`: the receipt is the evidence, the preview is a seven-day debugging
 * convenience.
 */

import { purgeExpiredPayloads } from '../purge.js'
import { isDirectRun, openPool, requireEnv, runCli } from './cli.js'

/** Returns the number of payload rows deleted. Zero is a normal, correct outcome. */
export async function runPurge(env: Record<string, string | undefined> = process.env): Promise<number> {
  const connectionString = requireEnv('DATABASE_URL', env)

  const { pool, end } = openPool(connectionString)

  try {
    const { deleted } = await purgeExpiredPayloads(pool)
    return deleted
  } finally {
    await end()
  }
}

if (isDirectRun(import.meta.url)) {
  void runCli(async () => {
    const deleted = await runPurge()
    console.log(`[mstamp] purged ${deleted} expired payload(s)`)
  })
}
