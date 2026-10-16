/**
 * Local receipt storage, on SQLite.
 *
 * The SDK must be able to record evidence with no network and no server, so this
 * is the local mode's source of truth. It mirrors the `Receipt` type one column per
 * field, so a receipt round-trips without loss - including the distinction between
 * `null` and a value, which matters because an unsigned receipt stores `null` in
 * `keyId`, `serverSignature` and `signedAt`.
 *
 * Uses Node's built-in `node:sqlite` (Node 22+). That is a deliberate choice: no
 * native module to compile, no prebuilt binary to fetch, and no new dependency in a
 * package whose whole point is having very few.
 *
 * Two things this module deliberately does NOT do:
 *
 *   - **No cloud sync.** That is 2b-ii. `put()` writes locally and returns.
 *   - **No raw payload storage.** Receipts contain hashes and metadata, not bodies,
 *     which is what makes encryption unnecessary here (see the original spec: hash-only is
 *     the V1 answer to field-level encryption).
 *
 * `put()` THROWS on failure. A store that silently swallowed a write error would
 * lose evidence while reporting success. Callers on the telemetry path are
 * expected to wrap it - the queue already models how (drop and log, never block).
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Attestation, Receipt, Registration, SchemaVersion, ValidationResult } from './types.js'

/** Bumped when the local schema changes. Recorded in `PRAGMA user_version`. */
export const LOCAL_SCHEMA_VERSION = 1

const TABLE = 'receipts'

/** One column per `Receipt` field, in the order the type declares them. */
const COLUMNS = [
  'schema_version',
  'receipt_id',
  'tenant_id',
  'seller_id',
  'provider',
  'operation',
  'request_hash',
  'response_hash',
  'status_code',
  'latency_ms',
  'timestamp',
  'registration',
  'attestation',
  'validation',
  'anomaly',
  'buyer_override',
  'sdk_version',
  'key_id',
  'server_signature',
  'signed_at',
] as const

type Column = (typeof COLUMNS)[number]

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  schema_version   TEXT    NOT NULL,
  receipt_id       TEXT    PRIMARY KEY,
  tenant_id        TEXT    NOT NULL,
  seller_id        TEXT,
  provider         TEXT    NOT NULL,
  operation        TEXT    NOT NULL,
  request_hash     TEXT    NOT NULL,
  response_hash    TEXT    NOT NULL,
  status_code      INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  timestamp        TEXT    NOT NULL,
  registration     TEXT    NOT NULL,
  attestation      TEXT    NOT NULL,
  validation       TEXT    NOT NULL,
  anomaly          TEXT,
  buyer_override   TEXT,
  sdk_version      TEXT    NOT NULL,
  key_id           TEXT,
  server_signature TEXT,
  signed_at        TEXT
)`

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_tenant_time ON ${TABLE} (tenant_id, timestamp DESC)`

const INSERT_SQL = `INSERT OR REPLACE INTO ${TABLE} (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `$${c}`).join(', ')})`

export type LocalReceiptStoreOptions = {
  /** Path to the SQLite file, or `':memory:'` for an ephemeral store. */
  path: string
  /**
   * Use WAL journalling (default `true` for file-backed stores).
   *
   * WAL is what lets a second connection read and write while another holds the
   * write lock, instead of failing with SQLITE_BUSY.
   */
  wal?: boolean
}

function rowToReceipt(row: Record<string, unknown>): Receipt {
  const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

  return {
    schemaVersion: String(row['schema_version']) as SchemaVersion,
    receiptId: String(row['receipt_id']),
    tenantId: String(row['tenant_id']),
    sellerId: nullable(row['seller_id']),
    provider: String(row['provider']),
    operation: String(row['operation']),
    requestHash: String(row['request_hash']),
    responseHash: String(row['response_hash']),
    statusCode: Number(row['status_code']),
    latencyMs: Number(row['latency_ms']),
    timestamp: String(row['timestamp']),
    registration: String(row['registration']) as Registration,
    attestation: String(row['attestation']) as Attestation,
    validation: JSON.parse(String(row['validation'])) as ValidationResult,
    // Reserved V2 fields. The columns exist so a V2 writer can populate them
    // without a migration; in V1 they are always NULL.
    anomaly: null,
    buyerOverride: null,
    sdkVersion: String(row['sdk_version']),
    keyId: nullable(row['key_id']),
    serverSignature: nullable(row['server_signature']),
    signedAt: nullable(row['signed_at']),
  }
}

/** Map a receipt onto the parameter object for `INSERT_SQL`. */
function receiptToParams(receipt: Receipt): Record<string, string | number | null> {
  const params: Record<string, string | number | null> = {
    $schema_version: receipt.schemaVersion,
    $receipt_id: receipt.receiptId,
    $tenant_id: receipt.tenantId,
    $seller_id: receipt.sellerId,
    $provider: receipt.provider,
    $operation: receipt.operation,
    $request_hash: receipt.requestHash,
    $response_hash: receipt.responseHash,
    $status_code: receipt.statusCode,
    $latency_ms: receipt.latencyMs,
    $timestamp: receipt.timestamp,
    $registration: receipt.registration,
    $attestation: receipt.attestation,
    // Nested objects are stored as JSON text rather than normalised into child
    // tables: validation is read as a unit and never queried by field.
    $validation: JSON.stringify(receipt.validation),
    $anomaly: null,
    $buyer_override: null,
    $sdk_version: receipt.sdkVersion,
    $key_id: receipt.keyId,
    $server_signature: receipt.serverSignature,
    $signed_at: receipt.signedAt,
  }

  // Guard against a column being added to one list and not the other: node:sqlite
  // would throw on an unknown key, but this fails earlier with a clearer message.
  const missing = COLUMNS.filter((column) => !(`$${column}` in params))
  if (missing.length > 0) {
    throw new Error(`receiptToParams is missing columns: ${missing.join(', ')}`)
  }

  return params
}

export type ReceiptFilter = {
  readonly provider?: string
  readonly tenantId?: string
  readonly limit?: number
}

export class LocalReceiptStore {
  #db: DatabaseSync
  #path: string
  #insert: ReturnType<DatabaseSync['prepare']>
  #selectOne: ReturnType<DatabaseSync['prepare']>
  #count: ReturnType<DatabaseSync['prepare']>

  constructor(options: LocalReceiptStoreOptions) {
    this.#path = options.path

    if (options.path !== ':memory:') {
      // The store is meant to work in a fresh process on a machine where nothing
      // has been set up yet, so create the directory rather than failing.
      mkdirSync(dirname(options.path), { recursive: true })
    }

    this.#db = new DatabaseSync(options.path)

    if (options.path !== ':memory:') {
      this.#db.exec('PRAGMA busy_timeout = 5000')
      if (options.wal !== false) {
        this.#db.exec('PRAGMA journal_mode = WAL')
        // With WAL, synchronous=NORMAL keeps the database uncorrupted across an
        // application crash while avoiding an fsync per commit. That is the
        // difference between ~30ms and well under a millisecond per receipt on a
        // slow filesystem, and it is why interleaved writers stay fast. The
        // trade-off is that the final transactions can be lost on power failure,
        // which is acceptable here: this is a local record whose durable copy is
        // the backend.
        this.#db.exec('PRAGMA synchronous = NORMAL')
      }
    }

    this.migrate()

    this.#insert = this.#db.prepare(INSERT_SQL)
    this.#selectOne = this.#db.prepare(`SELECT * FROM ${TABLE} WHERE receipt_id = ?`)
    this.#count = this.#db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`)
  }

  /** Path this store is backed by. */
  get path(): string {
    return this.#path
  }

  /** Create the schema if absent. Idempotent; safe to call on every open. */
  migrate(): void {
    this.#db.exec(CREATE_TABLE)
    this.#db.exec(CREATE_INDEX)

    const row = this.#db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const current = row?.user_version ?? 0

    if (current !== LOCAL_SCHEMA_VERSION) {
      // A real migration ladder goes here once there is more than one version.
      this.#db.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`)
    }
  }

  /**
   * Insert or replace a receipt, keyed on `receiptId`.
   *
   * Idempotent: re-ingesting the same receipt overwrites rather than duplicating,
   * which matches the backend's dedup rule.
   *
   * @throws if the write fails. Callers on the telemetry path must swallow.
   */
  put(receipt: Receipt): void {
    this.#insert.run(receiptToParams(receipt))
  }

  /**
   * Insert or replace many receipts in a single transaction.
   *
   * `put()` commits each row on its own, so a batch costs one fsync per receipt -
   * which dominates on a slow filesystem. This makes the whole batch cost one,
   * while leaving the database in exactly the same state.
   *
   * @throws if any write fails; the whole batch is rolled back.
   */
  putMany(receipts: readonly Receipt[]): void {
    if (receipts.length === 0) return

    this.#db.exec('BEGIN')
    try {
      for (const receipt of receipts) {
        this.#insert.run(receiptToParams(receipt))
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // The transaction was already unwound; the original error is what matters.
      }
      throw error
    }
  }

  /** Read one receipt by id, or `null`. */
  get(receiptId: string): Receipt | null {
    const row = this.#selectOne.get(receiptId) as Record<string, unknown> | undefined
    return row === undefined ? null : rowToReceipt(row)
  }

  /** Receipts, newest first. */
  list(filter: ReceiptFilter = {}): Receipt[] {
    const clauses: string[] = []
    const params: string[] = []

    if (filter.provider !== undefined) {
      clauses.push('provider = ?')
      params.push(filter.provider)
    }
    if (filter.tenantId !== undefined) {
      clauses.push('tenant_id = ?')
      params.push(filter.tenantId)
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const limit = filter.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : ''

    const rows = this.#db.prepare(`SELECT * FROM ${TABLE}${where} ORDER BY timestamp DESC${limit}`).all(...params)
    return rows.map((row) => rowToReceipt(row as Record<string, unknown>))
  }

  /** Number of stored receipts. */
  count(): number {
    const row = this.#count.get() as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  /**
   * SQLite's own integrity check. Returns `'ok'` for a healthy database.
   *
   * Exposed because "the writes did not corrupt anything" is a claim worth being
   * able to verify rather than infer from a row count.
   */
  integrityCheck(): string {
    const row = this.#db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    return row?.integrity_check ?? 'unknown'
  }

  /** Close the underlying database. Idempotent. */
  close(): void {
    try {
      this.#db.close()
    } catch {
      // Already closed; closing twice is not an error worth propagating.
    }
  }
}

// Re-exported so a consumer writing a column-oriented query has the canonical list.
export { COLUMNS as RECEIPT_COLUMNS }
export type { Column as ReceiptColumn }
