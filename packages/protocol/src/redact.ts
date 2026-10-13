/**
 * Redaction: strip secrets and personal data before anything is hashed or sent.
 *
 * Redaction runs BEFORE canonicalization and hashing, so the resulting hash
 * covers the redacted form. That is a deliberate, disclosed trade-off: the
 * receipt's `registration` field is how the buyer tells a verifier how much of
 * the original was withheld. Hashing the raw form instead would mean storing
 * (or transmitting) the secret in order to recompute it.
 *
 * Every function here is pure and returns a new structure. The SDK runs in
 * process with a live application, so mutating a caller's object - even to
 * remove a secret - would be an unacceptable side effect.
 *
 * What this deliberately does NOT do: detect secrets by inspecting values (an
 * API key pasted into a `description` field will not be caught), or redact
 * tokens embedded in a URL PATH (`/v1/keys/sk_live_abc`). Both are real gaps and
 * are listed as known limitations in the README.
 */

/** Replacement marker. Its exact text is covered by the hash, so keep it stable. */
export const REDACTED = '<redacted>'

/** Headers that are always stripped, regardless of pattern. */
export const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]

/**
 * Any header whose name matches this is stripped. The pattern is intentionally
 * broad: over-redacting a header costs a little debuggability, under-redacting
 * one leaks a credential into a signed, permanent record.
 */
export const DEFAULT_SENSITIVE_HEADER_PATTERN: RegExp = /token|secret|key|password|auth/i

/** Body field names redacted by default, matched on the final path segment. */
export const DEFAULT_REDACTED_BODY_KEYS: readonly string[] = [
  'email',
  'phone',
  'ssn',
  'credit_card',
  'password',
  'api_key',
  'token',
]

/** Query-string parameters stripped from stored URLs. */
export const DEFAULT_SENSITIVE_QUERY_PATTERN: RegExp = /token|secret|key|password|auth|sig|credential/i

/**
 * Overrides for the default policy.
 *
 * `null` for a pattern disables pattern matching entirely and falls back to the
 * explicit name list - useful when a buyer wants telemetry that is useful for
 * debugging and is willing to accept the disclosure.
 */
export type RedactionPolicy = {
  /** Replaces `DEFAULT_REDACTED_HEADERS` when provided. */
  headerNames?: readonly string[]
  /** Replaces `DEFAULT_SENSITIVE_HEADER_PATTERN` when provided; `null` disables it. */
  headerPattern?: RegExp | null
  /** Replaces `DEFAULT_REDACTED_BODY_KEYS` when provided. */
  bodyKeys?: readonly string[]
  /** Replaces `DEFAULT_SENSITIVE_QUERY_PATTERN` when provided; `null` disables it. */
  queryPattern?: RegExp | null
}

/**
 * `api_key`, `apiKey`, `api-key`, `API_KEY` and `apiKey` all name the same
 * secret. Comparing raw strings would miss three of the five and leak them.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/**
 * Test a pattern without the caller's regex carrying state between calls.
 *
 * A policy regex with the `g` or `y` flag advances `lastIndex` on every `test`,
 * which would make redaction alternate unpredictably between calls - a
 * genuinely nasty bug in a privacy control.
 */
function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function resolvePolicy(policy: RedactionPolicy): {
  headerNames: ReadonlySet<string>
  headerPattern: RegExp | null
  bodyKeys: ReadonlySet<string>
  queryPattern: RegExp | null
} {
  return {
    headerNames: new Set((policy.headerNames ?? DEFAULT_REDACTED_HEADERS).map(normalizeKey)),
    headerPattern: policy.headerPattern === undefined ? DEFAULT_SENSITIVE_HEADER_PATTERN : policy.headerPattern,
    bodyKeys: new Set((policy.bodyKeys ?? DEFAULT_REDACTED_BODY_KEYS).map(normalizeKey)),
    queryPattern: policy.queryPattern === undefined ? DEFAULT_SENSITIVE_QUERY_PATTERN : policy.queryPattern,
  }
}

/**
 * Return a copy of `headers` with secret-bearing values replaced by `REDACTED`.
 * Original header casing is preserved, because the receipt should look like the
 * request that was actually made.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  policy: RedactionPolicy = {},
): Record<string, string> {
  const { headerNames, headerPattern } = resolvePolicy(policy)
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    const sensitive = headerNames.has(normalizeKey(key)) || (headerPattern !== null && testPattern(headerPattern, key))
    out[key] = sensitive ? REDACTED : value
  }

  return out
}

function walkBody(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => walkBody(element, keys))
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      // A sensitive key is replaced wholesale rather than recursed into: the
      // whole subtree is assumed to be secret, so descending could leak a
      // nested field whose name happens not to match the policy.
      out[key] = keys.has(normalizeKey(key)) ? REDACTED : walkBody(nested, keys)
    }
    return out
  }

  return value
}

/**
 * Return a deep copy of `value` with sensitive fields replaced by `REDACTED`.
 *
 * Matching is on the exact (case- and separator-insensitive) field name, not a
 * substring. `tokenCount` is a count, not a credential, and redacting it would
 * break a buyer's own validation rules.
 *
 * Note the limits: `access_token` and `refresh_token` do not match the default
 * `token` key. Add them via `bodyKeys` if a provider uses those names - see the
 * README's known limitations.
 */
export function redactBody<T>(value: T, policy: RedactionPolicy = {}): T {
  const { bodyKeys } = resolvePolicy(policy)
  return walkBody(value, bodyKeys) as T
}

/**
 * Strip credentials and sensitive query parameters from a URL.
 *
 * The V1 spec redacts headers and body fields but stores `request.url` verbatim,
 * which would persist `?api_key=sk_live_...` and `https://user:pass@host` inside
 * a signed record. That gap is closed here.
 *
 * Unparseable input is returned unchanged rather than throwing: telemetry must
 * never be able to break the caller's request.
 */
export function redactUrl(url: string, policy: RedactionPolicy = {}): string {
  const { queryPattern } = resolvePolicy(policy)

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  if (parsed.username !== '') parsed.username = REDACTED
  if (parsed.password !== '') parsed.password = REDACTED

  if (queryPattern !== null) {
    // Snapshot the keys first: mutating during iteration is undefined behaviour.
    for (const key of [...parsed.searchParams.keys()]) {
      if (testPattern(queryPattern, key)) parsed.searchParams.set(key, REDACTED)
    }
  }

  return parsed.toString()
}
