/**
 * The payload retention job.
 *
 * Deletes encrypted previews past their expiry. **It never touches `receipts`** - the
 * receipt is the evidence and exists to be kept; the preview is a seven-day debugging
 * convenience. That asymmetry is the whole point of storing them separately.
 *
 * Scheduling is deliberately out of scope: this is a function for a scheduler to call
 * (Railway cron, a platform timer, `node -e`), so it can be tested and reasoned about
 * without owning a clock.
 *
 * Why it goes through a database function rather than a plain DELETE: row-level security
 * is enabled on `payloads`, so a `DELETE ... WHERE expires_at < now()` run as the
 * application role with no `app.tenant_id` set matches **zero rows**. The job would report
 * success and silently retain everything. `mstamp_purge_expired_payloads()` is
 * `SECURITY DEFINER`, so it runs with the table owner's rights and crosses tenants; see
 * migration 004.
 */

import { queryRows, withConnection, type DbPool } from './db/client.js'

export type PurgeResult = {
  /** Rows actually deleted. Zero is a normal, correct outcome. */
  readonly deleted: number
}

/**
 * Delete every payload whose `expires_at` has passed.
 *
 * Safe to call concurrently and safe to call repeatedly.
 */
export async function purgeExpiredPayloads(pool: DbPool): Promise<PurgeResult> {
  return withConnection(pool, async (connection) => {
    const rows = await queryRows<{ deleted: number | string | null }>(
      connection,
      'SELECT mstamp_purge_expired_payloads() AS deleted',
    )

    return { deleted: Number(rows[0]?.deleted ?? 0) }
  })
}
