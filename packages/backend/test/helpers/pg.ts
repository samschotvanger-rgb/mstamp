/**
 * Test database harness.
 *
 * Real Postgres, in-process: `@electric-sql/pglite` is PostgreSQL compiled to WASM, so
 * row-level security, policies and `SET LOCAL` behave exactly as they do in production
 * - unlike a JS emulator, which would let an RLS test pass without RLS ever running.
 * It also needs no server, so `pnpm test` works anywhere.
 *
 * Migrations run as the owner (which creates the tables and the `notched_app` role),
 * and then the session switches to `notched_app`. That switch is essential: a table
 * owner and a superuser both bypass RLS entirely, so without it every isolation
 * assertion here would be vacuous.
 */

import { PGlite } from '@electric-sql/pglite'

import { hashApiKey } from '../../src/auth.js'
import { withTenant, type DbConnection, type DbPool } from '../../src/db/client.js'
import { migrate } from '../../src/db/migrate.js'

/** The non-superuser application role created by migration 002. */
export const APP_ROLE = 'notched_app'

/**
 * Adapt PGlite to `DbPool`.
 *
 * The one place the two drivers genuinely differ: `pg` sends a **parameterless**
 * `query(text)` over the simple query protocol, which allows several statements in one
 * call - and that is exactly what the migration runner relies on to execute a whole
 * `.sql` file. PGlite's `query()` always uses the extended protocol and rejects
 * multiple commands, so parameterless calls are routed to `exec()`, which is its
 * simple-protocol equivalent.
 *
 * This mirrors `pg`'s behaviour rather than papering over it: statements still run in
 * one implicit transaction, and the returned rows are the last statement's, which is
 * what a single-statement caller expects.
 */
export function pglitePool(pglite: PGlite): DbPool {
  return {
    async connect(): Promise<DbConnection> {
      return {
        async query(sql: string, params?: readonly unknown[]) {
          if (params === undefined) {
            const results = await pglite.exec(sql)
            const last = results.at(-1)
            return { rows: (last?.rows ?? []) as unknown[] }
          }

          const result = await pglite.query(sql, [...params])
          return { rows: result.rows as unknown[] }
        },
      }
    },
  }
}

export type TestDb = {
  readonly pool: DbPool
  /**
   * Run work as the table owner, bypassing RLS.
   *
   * Only for inspecting raw state (e.g. proving rows exist that a tenant cannot see).
   * Never for anything a route would do.
   */
  asOwner<T>(fn: () => Promise<T>): Promise<T>
  /** Run an unscoped query as the app role, so RLS still applies. */
  unscoped<R>(sql: string, params?: readonly unknown[]): Promise<R[]>
  close(): Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite()
  const pool = pglitePool(pglite)

  await migrate(pool)

  // From here on, RLS is enforced.
  await pglite.exec(`SET ROLE ${APP_ROLE}`)

  return {
    pool,

    async asOwner<T>(fn: () => Promise<T>): Promise<T> {
      await pglite.exec('RESET ROLE')
      try {
        return await fn()
      } finally {
        await pglite.exec(`SET ROLE ${APP_ROLE}`)
      }
    },

    async unscoped<R>(sql: string, params?: readonly unknown[]): Promise<R[]> {
      if (params === undefined) {
        const results = await pglite.exec(sql)
        return (results.at(-1)?.rows ?? []) as R[]
      }
      const result = await pglite.query(sql, [...params])
      return result.rows as R[]
    },

    async close(): Promise<void> {
      await pglite.close()
    },
  }
}

export type SeedTenant = {
  readonly id: string
  readonly apiKey: string
  readonly name: string
  readonly plan?: string
  readonly spendLimitCents?: number
}

/** Insert a tenant. `tenants` has no RLS, so no tenant scope is needed. */
export async function seedTenant(db: TestDb, tenant: SeedTenant): Promise<void> {
  await db.unscoped(
    `INSERT INTO tenants (id, api_key_hash, name, plan, spend_limit_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenant.id, hashApiKey(tenant.apiKey), tenant.name, tenant.plan ?? 'free', tenant.spendLimitCents ?? 20000],
  )
}

export type SeedReceipt = {
  readonly id: string
  readonly tenantId: string
  readonly provider?: string
}

/**
 * Insert one receipt for a tenant.
 *
 * Goes through `withTenant` because `receipts` is RLS-protected: the WITH CHECK clause
 * would reject an insert whose tenant_id did not match the current setting.
 */
export async function seedReceipt(db: TestDb, receipt: SeedReceipt): Promise<void> {
  await withTenant(db.pool, receipt.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO receipts (
         id, tenant_id, seller_id, provider, operation,
         request_hash, response_hash, status_code, latency_ms, timestamp,
         registration, attestation, validation, anomaly, buyer_override,
         sdk_version, schema_version, key_id, server_signature, signed_at
       ) VALUES (
         $1, $2, NULL, $3, 'extract',
         $4, $5, 200, 10, now(),
         'hash-only', 'self', $6::jsonb, NULL, NULL,
         '0.1.0', '1', NULL, NULL, NULL
       )`,
      [
        receipt.id,
        receipt.tenantId,
        receipt.provider ?? 'scraper-x',
        `sha256:${'a'.repeat(64)}`,
        `sha256:${'b'.repeat(64)}`,
        JSON.stringify({ passed: false, rules: [], errors: [] }),
      ],
    )
  })
}
