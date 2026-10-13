/**
 * SHA-256 hashing in the Notched tagged format: `"sha256:" + lowercase hex`.
 *
 * Two distinct entry points exist because the request and the response are
 * hashed differently, and conflating them would be a real bug:
 *
 *   - `hashCanonicalJson` hashes the CANONICAL form of a JSON value. Used for
 *     request bodies, so that the same logical request always yields the same
 *     hash regardless of key order or formatting.
 *
 *   - `hashRawBytes` hashes bytes exactly as they arrived, with no decoding and
 *     no parsing. Used for response bodies, per the V1 spec ("raw bytes as
 *     received, before parsing"). This is what lets a receipt cover a malformed,
 *     truncated or non-JSON response - precisely the silent failures the product
 *     exists to catch. Decoding first would be lossy: every invalid UTF-8
 *     sequence collapses to U+FFFD, so two different bad responses would hash
 *     identically.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { canonicalizeToBytes } from './canonical.js'

/** Tag prepended to every hash so the algorithm is explicit and upgradable. */
export const HASH_PREFIX = 'sha256:'

const HASH_RE = /^sha256:[0-9a-f]{64}$/

const UTF8_ENCODER = new TextEncoder()

/** Lowercase hex SHA-256 of the given bytes. No prefix. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text`. No prefix. */
export function sha256HexUtf8(text: string): string {
  return sha256Hex(UTF8_ENCODER.encode(text))
}

/** Tagged `"sha256:<hex>"` hash of bytes exactly as received. */
export function hashRawBytes(bytes: Uint8Array): string {
  return `${HASH_PREFIX}${sha256Hex(bytes)}`
}

/**
 * Tagged hash of the RFC 8785 canonical form of a JSON value.
 *
 * @throws {CanonicalizationError} if the value is not I-JSON. Rejecting is
 * deliberate: hashing a silently-rewritten payload would produce a receipt that
 * does not match what the caller actually sent.
 */
export function hashCanonicalJson(value: unknown): string {
  return `${HASH_PREFIX}${sha256Hex(canonicalizeToBytes(value))}`
}

/** True if `value` is a well-formed tagged SHA-256 hash. */
export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}
