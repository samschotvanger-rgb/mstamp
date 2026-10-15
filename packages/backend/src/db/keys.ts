/**
 * Published public keys.
 *
 * A receipt names its signing key in `keyId`, and a verifier resolves that against this
 * table. Keys are published and **never deleted**: removing a rotated key would make
 * every receipt it signed unverifiable, which is the exact opposite of the product's
 * purpose. Migration 003 enforces that at the privilege level by granting the app role
 * `SELECT` and `INSERT` but not `DELETE`.
 *
 * There is no row-level security here - public keys are public, and a verifier needs
 * them before it has any tenant context.
 */

import { SIGNATURE_ALGORITHM, publicKeyBase64, type SigningKey } from '../crypto/sign.js'
import { queryRows, withConnection, type DbConnection, type DbPool } from './client.js'

export type PublishedKey = {
  readonly keyId: string
  readonly algorithm: string
  readonly publicKey: string
  readonly publishedAt: string
}

/**
 * Thrown when a key id is reused for a different key.
 *
 * This is a hard stop, not a warning. Overwriting the published key for an existing id
 * would silently break verification for every receipt already signed under that id -
 * and leaving the old key in place while signing with a new one would break every
 * *future* receipt. Neither is recoverable after the fact, so the process refuses to
 * start.
 */
export class SigningKeyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyConflictError'
  }
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}

async function selectStoredPublicKey(connection: DbConnection, keyId: string): Promise<string | undefined> {
  const rows = await queryRows<{ public_key: string }>(
    connection,
    'SELECT public_key FROM signing_keys WHERE key_id = $1',
    [keyId],
  )
  return rows[0]?.public_key
}

function assertSameKey(keyId: string, stored: string, expected: string): void {
  if (stored !== expected) {
    throw new SigningKeyConflictError(
      `signing key id ${JSON.stringify(keyId)} is already published with a different public key. ` +
        'Reusing a key id for a new key would make every receipt signed with it unverifiable. ' +
        'Generate a new key id (NOTCHED_SIGNING_KEY_ID) instead.',
    )
  }
}

/**
 * Record this instance's public key, if it is not already published.
 *
 * Idempotent, and safe against two instances starting at once: the insert is
 * `ON CONFLICT DO NOTHING` and the result is always read back rather than trusted, so a
 * concurrent disagreement is detected instead of being masked.
 */
export async function publishSigningKey(pool: DbPool, key: SigningKey): Promise<'created' | 'already-published'> {
  const publicKey = publicKeyBase64(key)

  return withConnection(pool, async (connection) => {
    const existing = await selectStoredPublicKey(connection, key.keyId)
    if (existing !== undefined) {
      assertSameKey(key.keyId, existing, publicKey)
      return 'already-published'
    }

    await connection.query(
      `INSERT INTO signing_keys (key_id, algorithm, public_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (key_id) DO NOTHING`,
      [key.keyId, SIGNATURE_ALGORITHM, publicKey],
    )

    const stored = await selectStoredPublicKey(connection, key.keyId)
    if (stored === undefined) {
      throw new Error(`signing key ${key.keyId} was not recorded`)
    }
    assertSameKey(key.keyId, stored, publicKey)

    return 'created'
  })
}

/**
 * Every key ever published, oldest first.
 *
 * The order is deliberate: a verifier looking for a key scans from the oldest, and a
 * human reading the list sees the history in the order it happened.
 */
export async function listPublishedKeys(pool: DbPool): Promise<PublishedKey[]> {
  return withConnection(pool, async (connection) => {
    const rows = await queryRows<{
      key_id: string
      algorithm: string
      public_key: string
      published_at: unknown
    }>(
      connection,
      'SELECT key_id, algorithm, public_key, published_at FROM signing_keys ORDER BY published_at ASC, key_id ASC',
    )

    return rows.map((row) => ({
      keyId: row.key_id,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      publishedAt: toIso(row.published_at),
    }))
  })
}
