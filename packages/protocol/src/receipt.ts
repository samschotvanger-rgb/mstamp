/**
 * The receipt signing payload - the exact bytes the mstamp backend signs and an
 * offline verifier must reconstruct.
 *
 * Why this lives in `@mstamp/protocol` rather than in the backend: the signer
 * and the verifier run in different processes, in different codebases, possibly
 * years apart. The only way to guarantee they agree is for both to call this one
 * function. Any reimplementation - however faithful - is a future signature
 * verification failure.
 *
 * The rule (original spec): canonical JSON of the receipt WITHOUT `serverSignature`
 * and `signedAt`. Those two fields are added after signing, so including them
 * would be circular.
 */

import { canonicalizeJson } from './canonical.js'
import { hashCanonicalJson } from './hash.js'
import type { Receipt, ReceiptSigningPayload } from './types.js'

/** Fields the signer supplies after signing, and which are therefore excluded. */
const UNSIGNED_FIELDS: readonly string[] = ['serverSignature', 'signedAt']

/**
 * Strip the two unsigned fields, returning a new object.
 *
 * Built by explicit exclusion rather than destructuring so the omission rule is
 * visible in one place and the input is never mutated.
 */
export function receiptSigningPayload(receipt: Receipt): ReceiptSigningPayload {
  const payload: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(receipt)) {
    if (UNSIGNED_FIELDS.includes(key)) continue
    payload[key] = value
  }

  return payload as ReceiptSigningPayload
}

/**
 * The canonical byte string (as text) that gets signed.
 *
 * @throws {CanonicalizationError} if the receipt contains a non-I-JSON value.
 * That should be impossible for a well-formed receipt, and failing loudly is
 * correct: signing a rewritten payload would produce an unverifiable receipt.
 */
export function canonicalizeReceiptForSigning(receipt: Receipt): string {
  return canonicalizeJson(receiptSigningPayload(receipt))
}

/** Tagged `"sha256:<hex>"` digest of the signing payload. Useful for logging and dedup. */
export function hashReceiptForSigning(receipt: Receipt): string {
  return hashCanonicalJson(receiptSigningPayload(receipt))
}

/**
 * True when the receipt carries a signature.
 *
 * A locally-written receipt (`registration: "local"`, `attestation: "self"`) has
 * no signature and stores `null` in both signed fields. Both must be present:
 * a signature without a signing time is not a usable attestation.
 */
export function isSignedReceipt(receipt: Receipt): boolean {
  return receipt.serverSignature !== null && receipt.signedAt !== null
}
