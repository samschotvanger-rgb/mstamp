/**
 * Receipt storage.
 *
 * Column names are snake_case to match the SQL in `migrations/`, and the mapping to the
 * camelCase `Receipt` type is explicit rather than clever - a silent mismatch between a
 * column and a field would change the bytes a signature covers, and that fails
 * invisibly.
 *
 * Everything here runs inside a `withTenant` transaction, so row-level security applies.
 */

import type { Attestation, Receipt, Registration, SchemaVersion, ValidationResult } from '@notched/protocol'

import { queryRows, withConnection, type DbConnection, type DbPool } from './client.js'

const INSERT_RECEIPT = `
  INSERT INTO receipts (
    id, tenant_id, seller_id, provider, operation,
    request_hash, response_hash, status_code, latency_ms, timestamp,
    registration, attestation, validation, anomaly, buyer_override,
    sdk_version, schema_version, key_id, server_signature, signed_at
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9, $10,
    $11, $12, $13::jsonb, $14::jsonb, $15::jsonb,
    $16, $17, $18, $19, $20
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id
`

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}

/**
 * Postgres hands back `jsonb` already parsed, but a driver or a `bytea`-ish path may not.
 * Accept both rather than depending on which driver is in use.
 */
function toJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function rowToReceipt(row: Record<string, unknown>): Receipt {
  return {
    schemaVersion: String(row['schema_version']) as SchemaVersion,
    receiptId: String(row['id']),
    tenantId: String(row['tenant_id']),
    sellerId: nullableString(row['seller_id']),
    provider: String(row['provider']),
    operation: String(row['operation']),
    requestHash: String(row['request_hash']),
    responseHash: String(row['response_hash']),
    statusCode: Number(row['status_code']),
    latencyMs: Number(row['latency_ms']),
    // Always come back through toISOString, so a value written as a string and a value
    // written as a Date produce identical text on the way out.
    timestamp: toIso(row['timestamp']),
    registration: String(row['registration']) as Registration,
    attestation: String(row['attestation']) as Attestation,
    validation: toJson(row['validation']) as ValidationResult,
    anomaly: null,
    buyerOverride: null,
    sdkVersion: String(row['sdk_version']),
    keyId: nullableString(row['key_id']),
    serverSignature: nullableString(row['server_signature']),
    signedAt: row['signed_at'] === null || row['signed_at'] === undefined ? null : toIso(row['signed_at']),
  }
}

/**
 * Insert a receipt.
 *
 * Idempotent on `receiptId`: an existing row wins and nothing is overwritten. That
 * matters because a receipt is a signed artefact - a second write must never be able to
 * change what was signed, or a receipt could be "amended" after the fact.
 *
 * @returns `true` when this call inserted the row, `false` when it already existed.
 */
export async function insertReceipt(tx: DbConnection, receipt: Receipt): Promise<boolean> {
  const result = await tx.query(INSERT_RECEIPT, [
    receipt.receiptId,
    receipt.tenantId,
    receipt.sellerId,
    receipt.provider,
    receipt.operation,
    receipt.requestHash,
    receipt.responseHash,
    receipt.statusCode,
    receipt.latencyMs,
    receipt.timestamp,
    receipt.registration,
    receipt.attestation,
    JSON.stringify(receipt.validation),
    null,
    null,
    receipt.sdkVersion,
    receipt.schemaVersion,
    receipt.keyId,
    receipt.serverSignature,
    receipt.signedAt,
  ])

  return result.rows.length > 0
}

/**
 * Read one receipt by id.
 *
 * Tenant-scoped by RLS: run it inside `withTenant`, or it returns nothing at all.
 */
export async function selectReceipt(tx: DbConnection, receiptId: string): Promise<Receipt | null> {
  const rows = await queryRows<Record<string, unknown>>(tx, 'SELECT * FROM receipts WHERE id = $1', [receiptId])
  const row = rows[0]

  return row === undefined ? null : rowToReceipt(row)
}

/**
 * Read a receipt for PUBLIC verification, crossing tenants.
 *
 * This is the one read that is deliberately not tenant-scoped, and it is not an oversight.
 * `GET /v1/receipts/:id/verify` takes no credentials by design - a verifier holds a
 * receipt and nothing else - so there is no tenant to scope by. The receipt id is the
 * capability: roughly 126 bits of nanoid, and the route exposes only
 * `{ valid, receiptId, signedAt, attestation, keyId }`, never the receipt contents.
 *
 * It goes through a `SECURITY DEFINER` database function rather than relaxing the RLS
 * policy, so the privilege is scoped to this one operation instead of making every
 * receipt readable. See migration 004.
 */
export async function selectReceiptForVerification(pool: DbPool, receiptId: string): Promise<Receipt | null> {
  return withConnection(pool, async (connection) => {
    const rows = await queryRows<Record<string, unknown>>(
      connection,
      'SELECT * FROM notched_get_receipt_for_verification($1)',
      [receiptId],
    )
    const row = rows[0]

    return row === undefined ? null : rowToReceipt(row)
  })
}
