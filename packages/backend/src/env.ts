/**
 * Shared backend types.
 *
 * Kept out of `app.ts` so middleware and routes can import them without a circular
 * dependency on the app factory.
 */

import type { DbConnection } from './db/client.js'

/** A tenant as the rest of the request sees it. Never carries the API key hash. */
export type Tenant = {
  readonly id: string
  readonly name: string
  readonly plan: string
  readonly spendLimitCents: number
}

export type AppVariables = {
  /** The authenticated tenant. Absent on public routes. */
  tenant: Tenant
  /**
   * Tenant-scoped data access, bound to the authenticated tenant.
   *
   * Routes must reach `receipts` and `payloads` through this rather than through the
   * pool, so they cannot accidentally use the wrong tenant - or no tenant at all.
   */
  withTenant: <T>(fn: (tx: DbConnection) => Promise<T>) => Promise<T>
}

export type AppEnv = {
  Variables: AppVariables
}
