/**
 * Database access with row-level tenant isolation.
 *
 * **The rule this file exists to enforce: `app.tenant_id` is set with `SET LOCAL`
 * inside a transaction, never with `SET`.**
 *
 * The difference is a security boundary, not a style preference. `SET` is
 * session-scoped, so on a pooled connection it survives the request that set it and
 * is inherited by whichever request next checks out that connection - silently
 * granting one tenant access to another's rows. `SET LOCAL` reverts at COMMIT or
 * ROLLBACK. `withTenant` is the only thing in the codebase that sets the value, and
 * it does so transaction-locally, so no route can get this wrong by accident.
 *
 * The value is applied with `set_config('app.tenant_id', $1, true)` rather than a
 * literal `SET LOCAL app.tenant_id = '...'`, because only the function form accepts
 * a bind parameter. Interpolating a tenant id into SQL would be an injection hole;
 * `set_config`'s third argument (`is_local = true`) is exactly `SET LOCAL`.
 *
 * `pg.PoolClient` and the PGlite connection used in tests both satisfy
 * `DbConnection`, so this code exercises real Postgres either way.
 */

import type { Pool } from 'pg'

/** What every query returns. Only `rows` is used; drivers add fields we ignore. */
export type QueryResult = { readonly rows: unknown[] }

/**
 * The minimal connection shape shared by `pg.PoolClient` and the single-connection
 * Postgres used in tests.
 */
export interface DbConnection {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>
  /** Present on pooled clients; absent on a single-connection harness. */
  release?(): void
}

export interface DbPool {
  connect(): Promise<DbConnection>
}

/** Typed row access. The connection interface stays untyped on purpose. */
export async function queryRows<R>(
  connection: DbConnection,
  sql: string,
  params?: readonly unknown[],
): Promise<R[]> {
  const result = await connection.query(sql, params)
  return result.rows as R[]
}

/** Wrap a `pg.Pool`. The production path. */
export function poolFromPg(pool: Pool): DbPool {
  return {
    async connect(): Promise<DbConnection> {
      const client = await pool.connect()

      return {
        async query(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
          const result = await client.query(sql, params === undefined ? undefined : [...params])
          return { rows: result.rows as unknown[] }
        },
        release: (): void => {
          client.release()
        },
      }
    },
  }
}

/**
 * Check out a connection, run `fn`, and always release it.
 *
 * For work that is deliberately NOT tenant-scoped: the API key lookup (which
 * happens before a tenant is known), migrations, and health checks. Anything that
 * touches `receipts` or `payloads` must go through `withTenant` instead.
 */
export async function withConnection<T>(pool: DbPool, fn: (connection: DbConnection) => Promise<T>): Promise<T> {
  const connection = await pool.connect()

  try {
    return await fn(connection)
  } finally {
    connection.release?.()
  }
}

/**
 * Run `fn` inside a transaction with `app.tenant_id` set for its duration.
 *
 * RLS reads that setting for every `receipts` and `payloads` query, so this is what
 * makes tenant isolation real. If it is never set, the policy comparison is against
 * NULL and the tenant sees **no rows** - it fails closed, which is the behaviour the
 * tests assert.
 *
 * @throws if `tenantId` is empty. An empty setting would silently mean "no tenant"
 * and hide every row, which is a bug worth failing loudly on.
 */
export async function withTenant<T>(
  pool: DbPool,
  tenantId: string,
  fn: (tx: DbConnection) => Promise<T>,
): Promise<T> {
  if (tenantId === '') {
    throw new Error('withTenant requires a non-empty tenant id')
  }

  const connection = await pool.connect()

  try {
    await connection.query('BEGIN')

    try {
      await connection.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])

      const result = await fn(connection)

      await connection.query('COMMIT')
      return result
    } catch (error) {
      try {
        await connection.query('ROLLBACK')
      } catch {
        // The transaction was already unwound; the original error is what matters.
      }
      throw error
    }
  } finally {
    connection.release?.()
  }
}

/**
 * Read back the tenant the current session would be scoped to.
 *
 * Exposed only for diagnostics and tests - notably to prove that the setting did
 * NOT survive the transaction (which is what distinguishes `SET LOCAL` from `SET`).
 */
export async function currentTenantSetting(connection: DbConnection): Promise<string | null> {
  const rows = await queryRows<{ current: string | null }>(
    connection,
    `SELECT current_setting('app.tenant_id', true) AS current`,
  )
  const value = rows[0]?.current
  return value === undefined || value === '' ? null : value
}
