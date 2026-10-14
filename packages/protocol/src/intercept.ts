/**
 * `fetch` interception: observe an API call without touching it.
 *
 * The single non-negotiable rule is that this module must be **invisible**. It
 * wraps `fetch`, and the caller's request and response must be exactly what they
 * would have been without it. Three consequences drive the whole design:
 *
 *   1. **The outgoing request is never modified.** We only read the caller's
 *      `RequestInit` - never write to it - and we never read a body we could only
 *      read by consuming it. A `ReadableStream` body is left alone.
 *
 *   2. **The returned `Response` is the very object the real `fetch` produced.**
 *      Not a copy, not a re-built response. To capture the bytes we call
 *      `response.clone()` (which tees the stream) and read the clone, so the
 *      caller's body is untouched and still readable.
 *
 *   3. **Capture happens after the caller already has their response.** The clone
 *      must be taken synchronously, before the caller can consume the body - but
 *      reading and hashing it is deferred off the response path. A caller who never
 *      awaits anything telemetry-related still gets every capture.
 *
 * Every failure mode ends the same way: the capture is abandoned and the caller
 * never knows. Network errors from the real `fetch` are the caller's own and
 * propagate untouched.
 *
 * Known cost: hashing the raw response bytes requires buffering the whole body in
 * memory. See the README's known limitations.
 */

import { canonicalizeJson } from './canonical.js'
import { hashCanonicalJson, hashRawBytes } from './hash.js'
import { redactBody, redactHeaders, redactUrl, type RedactionPolicy } from './redact.js'
import type { Registration } from './types.js'

/** A `fetch`-compatible function. Structural, so DOMMatrix-free environments work. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * One observed API call, flattened to map 1:1 onto `IngestEvent` fields.
 *
 * Every field is already redacted and every hash is in `"sha256:<hex>"` form, so
 * the consumer's only job is to move these values into a receipt.
 */
export type CapturedCall = {
  readonly method: string
  /** Redacted: sensitive query parameters and URL userinfo are stripped. */
  readonly url: string
  /** Redacted. */
  readonly requestHeaders: Record<string, string>
  /**
   * `"sha256:<hex>"` over the redacted, RFC 8785-canonicalized request body - the
   * locked V1 behaviour.
   *
   * `null` when no faithful hash was possible: a `FormData`, `Blob` or
   * `ReadableStream` body cannot be read without either consuming the caller's
   * request or inventing bytes the wire never carried. Reporting `null` is
   * deliberate; a guess here would be a receipt attesting to a request that was
   * never made.
   */
  readonly requestBodyHash: string | null
  /** Redacted body text, or `null`. Only ever populated in `full` registration. */
  readonly requestBodyPreview: string | null
  readonly status: number
  /** Redacted. */
  readonly responseHeaders: Record<string, string>
  /** `"sha256:<hex>"` over the raw response bytes exactly as received. */
  readonly responseBodyHash: string
  /** The raw response bytes, exactly as received. */
  readonly responseBytes: Uint8Array
  /** Redacted response text, or `null`. Only ever populated in `full` registration. */
  readonly responseBodyPreview: string | null
  readonly contentType: string
  /** Wall-clock duration of the `fetch` call itself, excluding our body read. */
  readonly latencyMs: number
  /** ISO 8601 UTC, taken when the call settled. */
  readonly timestamp: string
}

export type InterceptOptions = {
  /**
   * Receives each capture. Called on a deferred tick, never on the caller's path.
   *
   * A throw from this callback is swallowed: a broken consumer must not become a
   * broken API call.
   */
  onCapture?: (capture: CapturedCall) => void
  /**
   * How much may leave the process. Defaults to `hash-only`, the privacy-safe
   * choice; the SDK is expected to pass the resolved per-provider mode.
   */
  registration?: Registration
  /** Overrides for the default redaction policy. */
  redaction?: RedactionPolicy
  /** The `fetch` to wrap. Defaults to the global. */
  fetchImpl?: FetchLike
  /** Clock, for deterministic timestamps and latency in tests. */
  now?: () => number
  /** Schedules the deferred capture. Defaults to `setImmediate`, falling back to a timer. */
  schedule?: (task: () => void) => void
}

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function defaultSchedule(task: () => void): void {
  if (typeof setImmediate === 'function') {
    setImmediate(task)
    return
  }
  setTimeout(task, 0)
}

function tryParseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** Decode UTF-8, or `null` when the bytes are not valid UTF-8. */
function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    return null
  }
}

function isHeadersLike(value: unknown): value is { forEach(callback: (value: string, key: string) => void): void } {
  return typeof value === 'object' && value !== null && typeof (value as { forEach?: unknown }).forEach === 'function'
}

/** Normalise any `HeadersInit` into a plain record. Never throws. */
function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}

  try {
    // Arrays first: an array also has a `forEach`, but with (element, index)
    // arguments rather than (value, key).
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && pair.length >= 2) {
          out[String(pair[0])] = String(pair[1])
        }
      }
      return out
    }

    if (isHeadersLike(headers)) {
      headers.forEach((value, key) => {
        out[String(key)] = String(value)
      })
      return out
    }

    if (typeof headers === 'object' && headers !== null) {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (value !== undefined) out[key] = String(value)
      }
    }
  } catch {
    // A hostile or exotic HeadersInit yields whatever was readable so far.
  }

  return out
}

function isRequestLike(input: unknown): input is Request {
  if (typeof input !== 'object' || input === null) return false
  const candidate = input as { url?: unknown; method?: unknown }
  return typeof candidate.url === 'string' && typeof candidate.method === 'string'
}

type ObservedRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

/**
 * Read everything we need from the caller's request without writing to it.
 *
 * Property reads only. `init` is never assigned to, and a `Request` input is
 * cloned rather than consumed.
 */
function observeRequest(input: unknown, init: RequestInit | undefined, redaction: RedactionPolicy): ObservedRequest {
  let method = 'GET'
  let url = ''
  let headers: Record<string, string> = {}
  const body: unknown = init?.body ?? null

  if (typeof input === 'string') {
    url = input
  } else if (input instanceof URL) {
    url = input.toString()
  } else if (isRequestLike(input)) {
    url = input.url
    method = input.method
    headers = headersToRecord(input.headers)
  }

  if (init?.method !== undefined) method = init.method
  if (init?.headers !== undefined) headers = headersToRecord(init.headers)

  return {
    method: method.toUpperCase(),
    url: redactUrl(url, redaction),
    headers: redactHeaders(headers, redaction),
    body,
  }
}

/** Hash an already-parsed JSON body: redact, canonicalise, then hash. */
function hashJsonValueBody(
  value: unknown,
  redaction: RedactionPolicy,
  registration: Registration,
): { readonly hash: string; readonly preview: string | null } {
  const redacted = redactBody(value, redaction)
  return {
    hash: hashCanonicalJson(redacted),
    preview: registration === 'full' ? canonicalizeJson(redacted) : null,
  }
}

/**
 * Hash a request body as the caller supplied it: redacted-canonical for JSON, raw
 * bytes otherwise.
 *
 * A non-JSON body is hashed raw and gets NO preview, because structural redaction
 * is impossible and a raw preview could disclose a credential verbatim. Hashing
 * it raw is safe: a hash reveals nothing on its own.
 */
function hashRequestBody(
  body: unknown,
  redaction: RedactionPolicy,
  registration: Registration,
): { readonly hash: string | null; readonly preview: string | null } {
  if (body === null || body === undefined) {
    // "No body" is the JSON value null, which is distinguishable from an
    // empty-string body (which canonicalises to `""`). Hashing empty bytes would
    // conflate the two.
    return { hash: hashCanonicalJson(null), preview: registration === 'full' ? 'null' : null }
  }

  if (typeof body === 'string') {
    const parsed = tryParseJson(body)
    if (parsed.ok) return hashJsonValueBody(parsed.value, redaction, registration)
    return { hash: hashRawBytes(UTF8_ENCODER.encode(body)), preview: null }
  }

  if (body instanceof Uint8Array) {
    return { hash: hashRawBytes(body), preview: null }
  }

  if (body instanceof ArrayBuffer) {
    return { hash: hashRawBytes(new Uint8Array(body)), preview: null }
  }

  // Any other ArrayBuffer view (Uint16Array, DataView, ...).
  if (ArrayBuffer.isView(body)) {
    return {
      hash: hashRawBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      preview: null,
    }
  }

  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { hash: hashRawBytes(UTF8_ENCODER.encode(body.toString())), preview: null }
  }

  // FormData, Blob, ReadableStream, and anything exotic. Reading these would
  // consume the caller's request or produce bytes that differ from the wire
  // encoding. Report null rather than invent a hash.
  return { hash: null, preview: null }
}

/** Hash a response body: raw bytes as received, with a redacted preview in `full`. */
function hashResponseBody(
  bytes: Uint8Array,
  redaction: RedactionPolicy,
  registration: Registration,
): { readonly hash: string; readonly preview: string | null } {
  const hash = hashRawBytes(bytes)

  if (registration !== 'full') return { hash, preview: null }

  const text = tryDecodeUtf8(bytes)
  if (text === null) return { hash, preview: null }

  const parsed = tryParseJson(text)
  if (!parsed.ok) return { hash, preview: null }

  return { hash, preview: canonicalizeJson(redactBody(parsed.value, redaction)) }
}

function readContentType(headers: Record<string, string>): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') return value
  }
  return ''
}

type CaptureInput = {
  readonly observed: ObservedRequest
  readonly requestClone: Request | undefined
  readonly responseClone: Response
  readonly status: number
  readonly responseHeaders: Record<string, string>
  readonly startedAt: number
  readonly settledAt: number
  readonly redaction: RedactionPolicy
  readonly registration: Registration
}

/** Read the bodies and assemble the capture. Called off the caller's path. */
async function buildCapture(input: CaptureInput): Promise<CapturedCall> {
  const { observed, requestClone, responseClone, redaction, registration } = input

  // Prefer the body we could read without side effects; fall back to a clone of
  // the Request, which is the only non-destructive way to reach a body carried by
  // the Request object itself.
  //
  // The clone path yields BYTES, so JSON parsing happens here and the parsed value
  // goes straight to the JSON hasher - it must not be routed through
  // `hashRequestBody`, which handles the shapes a caller can pass as `init.body`.
  let requestHashed: { readonly hash: string | null; readonly preview: string | null }

  if (observed.body === null && requestClone !== undefined) {
    const requestBytes = new Uint8Array(await requestClone.arrayBuffer())
    const text = tryDecodeUtf8(requestBytes)
    const parsed = text === null ? { ok: false as const } : tryParseJson(text)
    requestHashed = parsed.ok
      ? hashJsonValueBody(parsed.value, redaction, registration)
      : { hash: hashRawBytes(requestBytes), preview: null }
  } else {
    requestHashed = hashRequestBody(observed.body, redaction, registration)
  }

  const responseBytes = new Uint8Array(await responseClone.arrayBuffer())
  const responseHashed = hashResponseBody(responseBytes, redaction, registration)

  return {
    method: observed.method,
    url: observed.url,
    requestHeaders: observed.headers,
    requestBodyHash: requestHashed.hash,
    requestBodyPreview: requestHashed.preview,
    status: input.status,
    responseHeaders: input.responseHeaders,
    responseBodyHash: responseHashed.hash,
    responseBytes,
    responseBodyPreview: responseHashed.preview,
    contentType: readContentType(input.responseHeaders),
    latencyMs: input.settledAt - input.startedAt,
    timestamp: new Date(input.settledAt).toISOString(),
  }
}

/**
 * Wrap `fetch`.
 *
 * The returned function is a drop-in replacement: same signature, same response
 * object, same errors, same bytes.
 */
export function instrumentFetch(options: InterceptOptions = {}): FetchLike {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  const onCapture = options.onCapture
  const registration = options.registration ?? 'hash-only'
  const redaction = options.redaction ?? {}
  const now = options.now ?? ((): number => Date.now())
  const schedule = options.schedule ?? defaultSchedule

  if (typeof fetchImpl !== 'function') {
    // Fail like `fetch` would rather than throwing synchronously.
    return () => Promise.reject(new Error('no fetch implementation available'))
  }

  return async function instrumentedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const startedAt = now()

    // Everything observed before the call. Property reads only.
    const observed = observeRequest(input, init, redaction)

    // A Request's own body can only be reached by cloning, and the clone must be
    // taken before `fetch` consumes the original.
    let requestClone: Request | undefined
    if (onCapture !== undefined && typeof Request !== 'undefined' && input instanceof Request) {
      try {
        requestClone = input.clone()
      } catch {
        requestClone = undefined
      }
    }

    // The primary call. Its errors belong to the caller.
    const response = await fetchImpl(input, init)
    const settledAt = now()

    // Clone synchronously, before the caller can disturb the body: after that,
    // `clone()` throws.
    let responseClone: Response | undefined
    if (onCapture !== undefined) {
      try {
        responseClone = response.clone()
      } catch {
        responseClone = undefined
      }
    }

    if (onCapture !== undefined && responseClone !== undefined) {
      const captureInput: CaptureInput = {
        observed,
        requestClone,
        responseClone,
        status: response.status,
        responseHeaders: redactHeaders(headersToRecord(response.headers), redaction),
        startedAt,
        settledAt,
        redaction,
        registration,
      }

      const callback = onCapture

      // Deferred, and guarded twice: `schedule` itself could throw, and the capture
      // could reject. Neither may reach the caller.
      try {
        schedule(() => {
          void buildCapture(captureInput)
            .then((capture) => {
              try {
                callback(capture)
              } catch {
                // A broken consumer is not the caller's problem.
              }
            })
            .catch(() => {
              // Capture failed. The response has already been returned.
            })
        })
      } catch {
        // The scheduler failed; skip this capture.
      }
    }

    // The identical object the real fetch produced.
    return response
  }
}
