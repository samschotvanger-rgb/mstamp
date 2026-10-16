/**
 * API key authentication.
 *
 * API keys only - no JWT, no sessions, per the original spec. The key is hashed with
 * the same SHA-256 implementation the rest of mstamp uses, and looked up against
 * `tenants.api_key_hash`. The key itself is never stored and never logged.
 *
 * Note where `app.tenant_id` is set and where it is not. This middleware resolves
 * *who* the caller is; it does not hold a connection open for the whole request,
 * because that would pin a pooled connection per in-flight request and a session-level
 * `SET` would leak the tenant to whoever gets that connection next. Instead it puts
 * the tenant in the request context and hands routes a `withTenant` bound to it, and
 * `db/client.ts` sets the value transaction-locally on whatever connection it checks
 * out. Same guarantee, no connection pinning.
 *
 * The `tenants` table deliberately has no row-level security: this lookup happens
 * before any tenant is known, so it cannot be tenant-scoped.
 */

import { hashRawBytes } from '@mstamp/protocol'
import type { MiddlewareHandler } from 'hono'

import { queryRows, withConnection, withTenant, type DbConnection, type DbPool } from './db/client.js'
import type { AppEnv, Tenant } from './env.js'

/** Header carrying the API key. Case-insensitive per HTTP; Hono normalises it. */
export const API_KEY_HEADER = 'X-API-Key'

const UTF8_ENCODER = new TextEncoder()

/**
 * Hash an API key the way `tenants.api_key_hash` stores it.
 *
 * Plain SHA-256, not a slow KDF, and that is correct here: API keys are
 * high-entropy random strings, so there is no dictionary to attack. The same choice
 * would be wrong for user-chosen passwords.
 */
export function hashApiKey(apiKey: string): string {
  return hashRawBytes(UTF8_ENCODER.encode(apiKey))
}

/**
 * Resolve a tenant from a raw API key, or `null`.
 *
 * Runs unscoped by necessity; `tenants` has no RLS.
 */
export async function findTenantByApiKey(connection: DbConnection, apiKey: string): Promise<Tenant | null> {
  if (apiKey === '') return null

  const rows = await queryRows<{
    id: string
    name: string
    plan: string
    spend_limit_cents: number
  }>(
    connection,
    'SELECT id, name, plan, spend_limit_cents FROM tenants WHERE api_key_hash = $1',
    [hashApiKey(apiKey)],
  )

  const row = rows[0]
  if (row === undefined) return null

  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    spendLimitCents: row.spend_limit_cents,
  }
}

/**
 * Hono middleware: require a valid `X-API-Key`, or answer 401.
 *
 * Both failure modes return 401 with the same shape but different codes, so a client
 * can tell "you sent nothing" from "your key is wrong" without either response
 * revealing whether a key exists.
 */
export function apiKeyAuth(pool: DbPool): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const provided = c.req.header(API_KEY_HEADER)

    if (provided === undefined || provided === '') {
      return c.json({ error: 'missing_api_key' }, 401)
    }

    const tenant = await withConnection(pool, (connection) => findTenantByApiKey(connection, provided))

    if (tenant === null) {
      return c.json({ error: 'invalid_api_key' }, 401)
    }

    c.set('tenant', tenant)
    c.set('withTenant', <T>(fn: (tx: DbConnection) => Promise<T>): Promise<T> => withTenant(pool, tenant.id, fn))

    // `return` rather than a bare `await`, so the handler has no path that falls off
    // the end without a value.
    return next()
  }
}
