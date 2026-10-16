/**
 * Body previews: what gets encrypted, and when.
 *
 * Previews exist so a buyer can see what a provider actually returned when a validation
 * rule failed. They are the only near-verbatim data mstamp stores, which is why three
 * things are true of them:
 *
 *   - **Only `full` registration stores them.** `hash-only` and `local` never do. This is
 *     re-checked here rather than trusted from the caller, because the whole point of
 *     `hash-only` is that previews do not leave the process.
 *   - **They are always encrypted** before reaching the database.
 *   - **They expire after seven days.** The receipt is the evidence; the preview is
 *     debugging.
 *
 * Both directions take a `tenantId` and use it to derive the key, so decrypting one
 * tenant's envelope with another's key fails authentication rather than returning
 * plausible-looking bytes.
 */

import { decryptForTenant, encryptForTenant } from './crypto/encrypt.js'
import { insertEncryptedPayload, selectEncryptedPayload } from './db/payloads.js'
import type { DbConnection } from './db/client.js'
import type { Registration } from '@mstamp/protocol'

export type StoredPreviews = {
  readonly request: string | null
  readonly response: string | null
}

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Thrown when a stored envelope cannot be read back as previews. */
export class PreviewDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewDecodeError'
  }
}

function isStoredPreviews(value: unknown): value is StoredPreviews {
  if (typeof value !== 'object' || value === null) return false

  const record = value as Record<string, unknown>
  const isNullableString = (entry: unknown): boolean => entry === null || typeof entry === 'string'

  return isNullableString(record['request']) && isNullableString(record['response'])
}

/** True when there is actually something worth storing. */
export function hasPreviews(previews: StoredPreviews): boolean {
  return previews.request !== null || previews.response !== null
}

/** Encrypt a preview pair into a storable envelope. */
export function encryptPreviews(masterKey: Uint8Array, tenantId: string, previews: StoredPreviews): Uint8Array {
  return encryptForTenant(masterKey, tenantId, UTF8_ENCODER.encode(JSON.stringify(previews)))
}

/**
 * Decrypt an envelope back into a preview pair.
 *
 * @throws {DecryptionError} when authentication fails (wrong tenant or master key).
 * @throws {PreviewDecodeError} when the plaintext is not a preview pair, which would mean
 * the row is corrupt rather than merely unreadable.
 */
export function decryptPreviews(masterKey: Uint8Array, tenantId: string, envelope: Uint8Array): StoredPreviews {
  const plaintext = decryptForTenant(masterKey, tenantId, envelope)

  let parsed: unknown
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(plaintext)) as unknown
  } catch {
    throw new PreviewDecodeError('decrypted payload is not valid UTF-8 JSON')
  }

  if (!isStoredPreviews(parsed)) {
    throw new PreviewDecodeError('decrypted payload is not a { request, response } preview pair')
  }

  return parsed
}

/**
 * Store previews for a receipt, if the registration mode allows it.
 *
 * @returns `true` when a row was written, `false` when there was nothing to store or the
 * mode forbids it.
 */
export async function storePreviews(
  tx: DbConnection,
  params: {
    readonly masterKey: Uint8Array
    readonly tenantId: string
    readonly receiptId: string
    readonly registration: Registration
    readonly previews: StoredPreviews
  },
): Promise<boolean> {
  if (params.registration !== 'full') return false
  if (!hasPreviews(params.previews)) return false

  const encrypted = encryptPreviews(params.masterKey, params.tenantId, params.previews)

  return insertEncryptedPayload(tx, {
    receiptId: params.receiptId,
    tenantId: params.tenantId,
    encrypted,
  })
}

/**
 * Read and decrypt previews for the owning tenant.
 *
 * @returns `null` when there is no stored payload (or RLS hides it).
 */
export async function loadPreviews(
  tx: DbConnection,
  params: { readonly masterKey: Uint8Array; readonly tenantId: string; readonly receiptId: string },
): Promise<StoredPreviews | null> {
  const envelope = await selectEncryptedPayload(tx, params.receiptId)
  if (envelope === null) return null

  return decryptPreviews(params.masterKey, params.tenantId, envelope)
}
