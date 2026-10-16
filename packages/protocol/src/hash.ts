/**
 * SHA-256 hashing in the mstamp tagged format: `"sha256:" + lowercase hex`.
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

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/**
 * Prefix marking a value that is deliberately NOT a hash.
 *
 * The prefix is load-bearing, not cosmetic. `sha256:unsupported-body-type` would
 * look like a malformed digest and invites a verifier to treat it as a corrupt
 * hash; `sentinel:` cannot be mistaken for one by any format check. A verifier
 * that validates hash format on one receipt must reach exactly the same
 * conclusion on every receipt, so a non-hash never wears a hash prefix.
 */
export const SENTINEL_PREFIX = 'sentinel:'

/**
 * Values used in a hash slot when no faithful hash exists.
 *
 * Both are recorded on the receipt alongside a matching `unvalidated:<reason>`
 * rule, so the gap is disclosed rather than hidden.
 */
export const SENTINELS = {
  /**
   * The request body was a `FormData`, `Blob` or `ReadableStream`.
   *
   * Reading those would either consume the caller's request or produce bytes that
   * differ from the wire encoding. Refusing to guess is the only honest option.
   */
  unsupportedBodyType: 'sentinel:unsupported-body-type',
  /** The response body exceeded `maxResponseBytes`, so it was neither hashed nor kept. */
  oversize: 'sentinel:oversize',
} as const

export type Sentinel = (typeof SENTINELS)[keyof typeof SENTINELS]

const SENTINEL_RE = /^sentinel:[a-z0-9-]+$/

/** True if `value` is a sentinel rather than a hash. */
export function isSentinel(value: unknown): value is string {
  return typeof value === 'string' && SENTINEL_RE.test(value)
}

/** `sentinel:oversize` -> `unvalidated:oversize`. The two prefixes mirror each other. */
export function sentinelToRule(sentinel: string): string {
  const reason = sentinel.startsWith(SENTINEL_PREFIX) ? sentinel.slice(SENTINEL_PREFIX.length) : sentinel
  return `unvalidated:${reason}`
}

/**
 * What occupies a receipt's `requestHash` / `responseHash` slot: either a real
 * tagged hash or a sentinel. Never both, and never anything else.
 */
export type HashOrSentinel = string
