/**
 * Ed25519 receipt signing and verification.
 *
 * The signature is the whole product: if it is wrong, every receipt is worthless. Three
 * things therefore matter more than anything else here.
 *
 *   1. **The signing payload comes from `@mstamp/protocol`, not from here.** It is
 *      produced by `canonicalizeReceiptForSigning`, which strips `serverSignature` and
 *      `signedAt` *entirely* (not set to null - omitted) and canonicalises the rest per
 *      RFC 8785. Reimplementing that in the backend would let the signer and the
 *      offline verifier drift, which fails silently and permanently.
 *
 *   2. **The signature covers the bytes, and the bytes are UTF-8.** Ed25519 signs
 *      bytes; the canonical string is encoded explicitly, never passed as a string.
 *
 *   3. **Verification returns false rather than throwing.** `@noble/ed25519` throws on
 *      a malformed-length signature instead of returning false. A verifier that crashes
 *      on a corrupt receipt is a denial-of-service surface, so every failure path here
 *      resolves to `false`.
 *
 * `@noble/ed25519`'s synchronous API needs `hashes.sha512` wired up first; the async
 * API does not, so only the async functions are used.
 */

import * as ed from '@noble/ed25519'

import { canonicalizeReceiptForSigning, type Receipt } from '@mstamp/protocol'

/** Algorithm identifier on the wire and in the database. */
export const SIGNATURE_ALGORITHM = 'ed25519'

/** Prefix on every signature value, so an algorithm change is explicit. */
export const SIGNATURE_PREFIX = 'ed25519:'

export const SEED_BYTES = 32
export const PUBLIC_KEY_BYTES = 32
export const SIGNATURE_BYTES = 64

/** Thrown for anything wrong with the configured signing key. */
export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyError'
  }
}

export type SigningKey = {
  readonly keyId: string
  /** The 32-byte Ed25519 seed - the actual secret. Never logged, never stored. */
  readonly seed: Uint8Array
  readonly publicKey: Uint8Array
}

const UTF8_ENCODER = new TextEncoder()

/**
 * Base64, standard alphabet, tolerating the URL-safe variant.
 *
 * Operators paste keys from all sorts of places, and `-`/`_` for `+`/`/` is the
 * commonest harmless variation.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Strict base64 decode.
 *
 * `Buffer.from(value, 'base64')` ignores invalid characters and returns a short or
 * empty buffer instead of failing, so a typo in a signing key would otherwise produce a
 * silently wrong key rather than a startup error. Returns `null` when the input is not
 * valid base64.
 */
export function base64ToBytes(value: string): Uint8Array | null {
  const trimmed = value.trim()
  if (trimmed === '') return null

  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/')
  if (!BASE64_RE.test(normalized)) return null

  const bytes = new Uint8Array(Buffer.from(normalized, 'base64'))
  return bytes.length > 0 ? bytes : null
}

/**
 * Parse `MSTAMP_SIGNING_KEY`: base64 of the 32-byte seed.
 *
 * @throws {SigningKeyError} with a message specific enough to fix without guessing.
 */
export function parseSigningSeed(base64: string): Uint8Array {
  const seed = base64ToBytes(base64)

  if (seed === null) {
    throw new SigningKeyError('MSTAMP_SIGNING_KEY is not valid base64')
  }
  if (seed.length !== SEED_BYTES) {
    throw new SigningKeyError(
      `MSTAMP_SIGNING_KEY must decode to ${SEED_BYTES} bytes (a raw Ed25519 seed), got ${seed.length}`,
    )
  }

  return seed
}

/** Derive the public key and wrap a seed as a usable signing key. */
export async function signingKeyFromSeed(seed: Uint8Array, keyId: string): Promise<SigningKey> {
  if (seed.length !== SEED_BYTES) {
    throw new SigningKeyError(`signing seed must be ${SEED_BYTES} bytes, got ${seed.length}`)
  }
  if (keyId === '') {
    throw new SigningKeyError('signing key id must not be empty')
  }

  return { keyId, seed, publicKey: await ed.getPublicKeyAsync(seed) }
}

/** Base64 of the raw public key, which is what `GET /v1/keys` publishes. */
export function publicKeyBase64(key: SigningKey): string {
  return bytesToBase64(key.publicKey)
}

function encodeSignature(signature: Uint8Array): string {
  return `${SIGNATURE_PREFIX}${bytesToBase64(signature)}`
}

/** Decode a `"ed25519:<base64>"` signature, or `null` when it is not one. */
export function decodeSignature(value: string): Uint8Array | null {
  if (!value.startsWith(SIGNATURE_PREFIX)) return null

  const bytes = base64ToBytes(value.slice(SIGNATURE_PREFIX.length))
  if (bytes === null || bytes.length !== SIGNATURE_BYTES) return null

  return bytes
}

export type SignReceiptResult = {
  readonly serverSignature: string
  /** ISO 8601 UTC. Excluded from the signed bytes, so its value is not covered. */
  readonly signedAt: string
}

/**
 * Sign a receipt.
 *
 * The receipt passed in is the *draft*: `serverSignature` and `signedAt` must still be
 * `null` (or anything else - they are omitted from the payload either way, which is
 * asserted by a test).
 *
 * @throws {CanonicalizationError} if the receipt is not I-JSON. That would be a bug in
 * the event construction rather than bad input, so it is not swallowed here.
 */
export async function signReceipt(
  receipt: Receipt,
  key: SigningKey,
  options: { now?: () => number } = {},
): Promise<SignReceiptResult> {
  const now = options.now ?? ((): number => Date.now())
  const signedAt = new Date(now()).toISOString()

  const payload = canonicalizeReceiptForSigning(receipt)
  const signature = await ed.signAsync(UTF8_ENCODER.encode(payload), key.seed)

  return { serverSignature: encodeSignature(signature), signedAt }
}

/**
 * Verify a receipt against a public key.
 *
 * Returns `false` for every failure - a bad prefix, bad base64, a wrong-length
 * signature, a wrong-length public key, a payload that cannot be canonicalised, or a
 * signature that simply does not match. It never throws.
 *
 * The caller is responsible for choosing the right key; `receipt.keyId` names it.
 */
export async function verifyReceipt(receipt: Receipt, publicKey: string): Promise<boolean> {
  try {
    if (receipt.serverSignature === null) return false

    const signature = decodeSignature(receipt.serverSignature)
    if (signature === null) return false

    const publicKeyBytes = base64ToBytes(publicKey)
    if (publicKeyBytes === null || publicKeyBytes.length !== PUBLIC_KEY_BYTES) return false

    const payload = UTF8_ENCODER.encode(canonicalizeReceiptForSigning(receipt))
    return await ed.verifyAsync(signature, payload, publicKeyBytes)
  } catch {
    // Includes the malformed-signature throw documented above, and any canonicalization
    // failure. A verifier answers "no", it does not propagate.
    return false
  }
}
