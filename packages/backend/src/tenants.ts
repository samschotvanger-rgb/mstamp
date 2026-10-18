/**
 * Tenant and API-key issuance.
 *
 * Before this existed, onboarding a customer meant hand-writing SQL with the correct
 * hash format - and `tenants.api_key_hash` stores the **tagged** `sha256:<hex>` form,
 * not bare hex, so getting it wrong produced a tenant whose key silently never
 * authenticated.
 *
 * Keys are 32 bytes of CSPRNG output. Plain SHA-256 is the right storage choice for
 * them precisely because they are high-entropy random strings rather than
 * user-chosen passwords; see `auth.ts`.
 */

import { randomBytes } from 'node:crypto'

import { randomId } from '@mstamp/protocol'

import { hashApiKey } from './auth.js'
import { withConnection, type DbPool } from './db/client.js'

/** Prefix on every issued key, so one is recognisable in a log or a pasted secret. */
export const API_KEY_PREFIX = 'mstamp_sk_'

/** Tenant ids are `tnt_` + a 21-character id, matching the SDK's local drafts. */
export const TENANT_ID_PREFIX = 'tnt_'

/** 32 bytes = 256 bits of entropy. */
const API_KEY_BYTES = 32

export type IssueTenantOptions = {
  readonly name: string
  readonly plan?: string
  readonly spendLimitCents?: number
}

export type IssuedTenant = {
  readonly tenantId: string
  /** Shown once and never stored. Only its SHA-256 is persisted. */
  readonly apiKey: string
}

/** A new high-entropy API key. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString('base64url')}`
}

/**
 * Create a tenant and its first API key.
 *
 * `tenants` has no row-level security - the key lookup happens before any tenant is
 * known, so it cannot be tenant-scoped - which is why this needs no tenant context.
 *
 * @throws if the name is blank. An unnamed tenant is an unidentifiable one.
 */
export async function issueTenantCredentials(
  pool: DbPool,
  options: IssueTenantOptions,
): Promise<IssuedTenant> {
  const name = options.name.trim()
  if (name === '') throw new Error('a tenant needs a name')

  const tenantId = `${TENANT_ID_PREFIX}${randomId(21)}`
  const apiKey = generateApiKey()

  await withConnection(pool, async (connection) => {
    await connection.query(
      `INSERT INTO tenants (id, api_key_hash, name, plan, spend_limit_cents)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, hashApiKey(apiKey), name, options.plan ?? 'free', options.spendLimitCents ?? 20000],
    )
  })

  return { tenantId, apiKey }
}
