/**
 * RFC 8785 (JCS) canonicalization - the one function every receipt depends on.
 *
 * Design: delegate the actual serialisation to `canonicalize` (see
 * `docs/canonicalization-decision.md` for why), and wrap it in an explicit
 * I-JSON guard.
 *
 * The guard is not belt-and-braces paranoia. The bake-off measured every
 * candidate implementation and found that `canonicalize`, `json-canonicalize`
 * and `json-freeze` ALL accept `{ a: undefined }` and emit `{}`. Silently
 * rewriting a payload and then hashing the rewrite is the worst possible failure
 * mode for a notary: the receipt would attest to a request that was never made,
 * and the buyer's own `requestHash` would not match what they sent. So the guard
 * rejects what the serializer would quietly drop.
 *
 * Ordering matters here: guard first, then serialise. The guard never mutates
 * and never transforms, so for valid input the output is byte-identical to
 * calling the library directly (asserted in `canonical.test.ts`).
 */

import canonicalize from 'canonicalize'

export type CanonicalizationErrorCode =
  /** `NaN`, `Infinity` or `-Infinity`: not representable in JSON (RFC 8785 3.2.2.3). */
  | 'NON_FINITE_NUMBER'
  /** A value with no JSON representation: `bigint`, `undefined`, function, symbol, or a non-plain object. */
  | 'UNSUPPORTED_TYPE'
  /** An object that contains itself, so serialisation could not terminate. */
  | 'CIRCULAR_REFERENCE'
  /** An unpaired UTF-16 surrogate, which RFC 8785 3.2.2.2 requires to be fatal. */
  | 'LONE_SURROGATE'

/** Thrown when a value cannot be canonicalized. Carries the path to the problem. */
export class CanonicalizationError extends Error {
  readonly code: CanonicalizationErrorCode
  readonly path: readonly string[]

  constructor(code: CanonicalizationErrorCode, path: readonly string[], detail: string) {
    super(`cannot canonicalize ${detail} at ${formatPath(path)}`)
    this.name = 'CanonicalizationError'
    this.code = code
    this.path = path
  }
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.')
}

/**
 * Matches an unpaired surrogate. Deliberately NOT the `u` flag: without it, the
 * pattern operates on UTF-16 code units, which is exactly the level at which
 * "paired" is defined.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** True for `{}`-style objects. A `Date`, `Map` or class instance is not one. */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Throw unless `value` is representable in I-JSON (RFC 7493), which RFC 8785
 * requires of its input.
 *
 * `ancestors` holds only the objects on the current path, not every object seen.
 * That distinction matters: `{ a: x, b: x }` shares a reference but is perfectly
 * legal, and a naive "seen" set would reject it as circular.
 */
function assertIJson(value: unknown, path: string[], ancestors: Set<object>): void {
  if (value === null) return

  switch (typeof value) {
    case 'boolean':
      return
    case 'string':
      if (LONE_SURROGATE_RE.test(value)) {
        throw new CanonicalizationError('LONE_SURROGATE', path, 'a string containing a lone surrogate')
      }
      return
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError('NON_FINITE_NUMBER', path, `the non-finite number ${String(value)}`)
      }
      return
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new CanonicalizationError('UNSUPPORTED_TYPE', path, `a ${typeof value} value`)
    default:
      break
  }

  const asObject = value as object

  if (ancestors.has(asObject)) {
    throw new CanonicalizationError('CIRCULAR_REFERENCE', path, 'a circular reference')
  }

  if (Array.isArray(asObject)) {
    ancestors.add(asObject)
    try {
      for (let i = 0; i < asObject.length; i++) {
        path.push(String(i))
        assertIJson(asObject[i], path, ancestors)
        path.pop()
      }
    } finally {
      ancestors.delete(asObject)
    }
    return
  }

  if (!isPlainObject(asObject)) {
    // A Date would silently become a string via toJSON; a Map or Set would
    // become `{}`. Both produce a receipt for a payload that never existed.
    throw new CanonicalizationError(
      'UNSUPPORTED_TYPE',
      path,
      `a non-plain object (${Object.prototype.toString.call(asObject)})`,
    )
  }

  ancestors.add(asObject)
  try {
    for (const key of Object.keys(asObject)) {
      if (LONE_SURROGATE_RE.test(key)) {
        throw new CanonicalizationError('LONE_SURROGATE', path, 'an object key containing a lone surrogate')
      }
      path.push(key)
      assertIJson((asObject as Record<string, unknown>)[key], path, ancestors)
      path.pop()
    }
  } finally {
    ancestors.delete(asObject)
  }
}

/**
 * Canonicalize a value to its RFC 8785 string form.
 *
 * @throws {CanonicalizationError} if the value is not I-JSON.
 */
export function canonicalizeJson(value: unknown): string {
  assertIJson(value, [], new Set())

  const output: unknown = canonicalize(value)
  if (typeof output !== 'string') {
    // Unreachable given the guard, but `canonicalize` is typed as possibly
    // returning undefined, and returning undefined from a hashing path would be
    // far worse than a loud failure.
    throw new CanonicalizationError('UNSUPPORTED_TYPE', [], 'a value the canonicalizer refused to serialise')
  }
  return output
}

const UTF8_ENCODER = new TextEncoder()

/**
 * Canonicalize to the UTF-8 bytes that are actually hashed and signed.
 *
 * RFC 8785 3.2.4 requires UTF-8 with no BOM; `TextEncoder` emits neither a BOM
 * nor a trailing newline.
 */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return UTF8_ENCODER.encode(canonicalizeJson(value))
}
