/**
 * Payload preview encryption: AES-256-GCM with a per-tenant key derived via HKDF.
 *
 * Raw body previews are the only thing mstamp stores that could contain a buyer's data
 * verbatim, and the original spec's rule is explicit: never store raw payloads without
 * encryption. They are also the only thing with a retention limit - seven days - because
 * they exist to help a buyer debug, not to be evidence. The receipt is the evidence, and
 * it holds hashes.
 *
 * Two design points that matter:
 *
 *   1. **Keys are derived, not stored.** `HKDF-SHA256(masterKey, salt, info)` where
 *      `info` binds the key to both the tenant and the purpose. So one master key yields
 *      an independent key per tenant, and a key derived for payloads can never be reused
 *      for something else. Nothing per-tenant needs to be stored or rotated separately.
 *
 *   2. **The tenant is authenticated, not just used.** AES-GCM's auth tag means
 *      decrypting tenant B's ciphertext with tenant A's key fails loudly rather than
 *      returning plausible garbage. That is the property that makes a "cross-tenant
 *      read" a failure instead of a silent data leak.
 *
 * Stored layout, versioned so the format can change later:
 *
 *     [1 byte version][12 byte IV][16 byte GCM tag][ciphertext...]
 *
 * A fresh random IV per encryption is required for GCM: reusing one with the same key is
 * catastrophic, so it is generated here and never supplied by a caller.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { base64ToBytes } from './sign.js'

/** Envelope format version. Bump when the layout changes. */
export const ENCRYPTION_VERSION = 1

export const MASTER_KEY_BYTES = 32
export const IV_BYTES = 12
export const TAG_BYTES = 16

/** version + IV + tag. Everything after this is ciphertext. */
export const ENVELOPE_HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES

/** Fixed application salt. The tenant and purpose go in `info`, not here. */
const HKDF_SALT = Buffer.from('mstamp/hkdf/v1', 'utf8')

/** Binds a derived key to its purpose, format version, and tenant. */
function hkdfInfo(tenantId: string): Buffer {
  return Buffer.from(`mstamp/payload/aes-256-gcm/v1/${tenantId}`, 'utf8')
}

/** Thrown for anything wrong with `MSTAMP_MASTER_KEY`. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MasterKeyError'
  }
}

/** Thrown when ciphertext cannot be authenticated. Never leaks why. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

/**
 * Parse `MSTAMP_MASTER_KEY`: base64 of 32 bytes.
 *
 * Same strictness as the signing key, for the same reason: a lenient base64 decode turns
 * a typo into a *different* key, and the symptom would be undecryptable payloads rather
 * than a startup error.
 */
export function parseMasterKey(base64: string): Uint8Array {
  const key = base64ToBytes(base64)

  if (key === null) {
    throw new MasterKeyError('MSTAMP_MASTER_KEY is not valid base64')
  }
  if (key.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(`MSTAMP_MASTER_KEY must decode to ${MASTER_KEY_BYTES} bytes, got ${key.length}`)
  }

  return key
}

/**
 * Derive the AES-256 key for one tenant.
 *
 * Deterministic: the same master key and tenant always give the same key, which is what
 * makes decryption possible without storing anything per tenant.
 */
export function deriveTenantKey(masterKey: Uint8Array, tenantId: string): Buffer {
  if (tenantId === '') {
    throw new MasterKeyError('cannot derive a tenant key without a tenant id')
  }

  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, hkdfInfo(tenantId), MASTER_KEY_BYTES))
}

/** Encrypt for one tenant. Returns the versioned envelope. */
export function encryptForTenant(masterKey: Uint8Array, tenantId: string, plaintext: Uint8Array): Uint8Array {
  const key = deriveTenantKey(masterKey, tenantId)
  const iv = randomBytes(IV_BYTES)

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return new Uint8Array(
    Buffer.concat([Buffer.from([ENCRYPTION_VERSION]), iv, cipher.getAuthTag(), ciphertext]),
  )
}

/**
 * Decrypt for one tenant.
 *
 * @throws {DecryptionError} when the envelope is malformed, the version is unknown, or
 * authentication fails - which covers the wrong tenant, the wrong master key, and
 * tampering alike. The message deliberately does not distinguish them.
 */
export function decryptForTenant(masterKey: Uint8Array, tenantId: string, envelope: Uint8Array): Uint8Array {
  if (envelope.length < ENVELOPE_HEADER_BYTES) {
    throw new DecryptionError('ciphertext is too short to be a valid envelope')
  }

  const version = envelope[0]
  if (version !== ENCRYPTION_VERSION) {
    throw new DecryptionError(`unsupported ciphertext version ${String(version)}`)
  }

  const iv = envelope.subarray(1, 1 + IV_BYTES)
  const tag = envelope.subarray(1 + IV_BYTES, ENVELOPE_HEADER_BYTES)
  const ciphertext = envelope.subarray(ENVELOPE_HEADER_BYTES)

  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveTenantKey(masterKey, tenantId), iv)
    decipher.setAuthTag(tag)
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  } catch {
    // GCM authentication failure. Indistinguishable by design: a different tenant, a
    // different master key, and a tampered blob are all "this is not yours".
    throw new DecryptionError('payload could not be authenticated for this tenant')
  }
}
