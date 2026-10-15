/**
 * Encrypted payload storage.
 *
 * Storage only - no crypto. The master key never reaches this module; callers hand it an
 * already-encrypted envelope. Keeping the two apart means the SQL here cannot accidentally
 * be called with plaintext, and the crypto in `crypto/encrypt.ts` cannot accidentally
 * depend on the database.
 *
 * Every function runs inside a `withTenant` transaction, so RLS applies and a row for
 * another tenant is invisible rather than merely rejected.
 */

import { queryRows, type DbConnection } from './client.js'

/** Previews are a debugging convenience, not evidence. They expire. */
export const PAYLOAD_RETENTION_DAYS = 7

/**
 * `make_interval` rather than string-concatenating the interval, so the retention period
 * stays a bind parameter.
 *
 * `ON CONFLICT DO NOTHING` mirrors receipts: a re-sent event must not overwrite what was
 * stored the first time.
 */
const INSERT_PAYLOAD = `
  INSERT INTO payloads (receipt_id, tenant_id, encrypted, expires_at)
  VALUES ($1, $2, $3, now() + make_interval(days => $4))
  ON CONFLICT (receipt_id) DO NOTHING
  RETURNING receipt_id
`

/**
 * Store one encrypted preview envelope.
 *
 * @returns `true` when inserted, `false` when a row already existed.
 */
export async function insertEncryptedPayload(
  tx: DbConnection,
  params: {
    readonly receiptId: string
    readonly tenantId: string
    readonly encrypted: Uint8Array
    readonly retentionDays?: number
  },
): Promise<boolean> {
  const result = await tx.query(INSERT_PAYLOAD, [
    params.receiptId,
    params.tenantId,
    params.encrypted,
    params.retentionDays ?? PAYLOAD_RETENTION_DAYS,
  ])

  return result.rows.length > 0
}

function toBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return new Uint8Array(value)

  // A driver that hands back `bytea` as text uses the `\x` hex form.
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value
    return new Uint8Array(Buffer.from(hex, 'hex'))
  }

  return null
}

/**
 * Read the encrypted envelope for a receipt, or `null`.
 *
 * RLS scopes this: without `app.tenant_id` set to the row's tenant, it returns nothing.
 */
export async function selectEncryptedPayload(tx: DbConnection, receiptId: string): Promise<Uint8Array | null> {
  const rows = await queryRows<{ encrypted: unknown }>(tx, 'SELECT encrypted FROM payloads WHERE receipt_id = $1', [
    receiptId,
  ])

  return toBytes(rows[0]?.encrypted)
}
