/**
 * Cloud ingestion: POST batched events to `/v1/ingest/batch`.
 *
 * Scope boundary, stated up front: **this module does not sign anything.** Receipt
 * signing is the backend's job. The SDK ships observations; the backend turns them
 * into signed receipts. Nothing here holds or derives a key.
 *
 * Division of labour with `TelemetryQueue`, which is deliberate and worth being
 * explicit about:
 *
 *   - **This module owns the HTTP contract** - URL, auth header, body shape,
 *     response shape, and the 100-event batch limit.
 *   - **The queue owns retry, backoff, the timeout and the circuit breaker.**
 *
 * So the "one retry after 500ms" and "respects the circuit breaker" requirements
 * are met by *using* the queue rather than reimplementing them here. Retrying in
 * both places would silently double the attempt count (four POSTs instead of two)
 * and put two uncorrelated breaker states in play.
 *
 * `postIngestBatch` throws on any failure, because the queue needs to see the
 * failure to count it. The caller never sees the throw: the queue catches, drops
 * and logs. That is the fail-open contract.
 */

import type { FetchLike } from './intercept.js'
import { MAX_EVENTS_PER_BATCH, type IngestEvent, type IngestRequest, type IngestResponse } from './types.js'

/** Path appended to the configured endpoint. */
export const INGEST_PATH = '/v1/ingest/batch'

/** How much of an error response body to keep for diagnostics. */
const ERROR_SNIPPET_LIMIT = 200

/** The backend answered, but not with a success status. */
export class IngestHttpError extends Error {
  readonly status: number
  readonly bodySnippet: string

  constructor(status: number, bodySnippet: string) {
    super(`ingest failed with HTTP ${status}${bodySnippet === '' ? '' : `: ${bodySnippet}`}`)
    this.name = 'IngestHttpError'
    this.status = status
    this.bodySnippet = bodySnippet
  }
}

/** The backend answered with a success status but a body we cannot trust. */
export class IngestProtocolError extends Error {
  constructor(detail: string) {
    super(`ingest response was not usable: ${detail}`)
    this.name = 'IngestProtocolError'
  }
}

export type CloudIngestOptions = {
  /** Host only, e.g. `https://ingest.example.com`. The path is appended. */
  endpoint: string
  apiKey: string
  /** Injected `fetch`, for tests and for non-global-fetch runtimes. */
  fetchImpl?: FetchLike
  /** Extra headers, merged over the defaults. */
  headers?: Record<string, string>
  /**
   * Called when a POST fails, before the error is rethrown for the queue.
   *
   * A throw from this callback is swallowed.
   */
  onError?: (error: unknown, events: readonly IngestEvent[]) => void
}

/** A `TelemetryQueue`-compatible transport: resolves on success, throws on failure. */
export type IngestTransport = (batch: readonly IngestEvent[]) => Promise<void>

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > ERROR_SNIPPET_LIMIT ? `${text.slice(0, ERROR_SNIPPET_LIMIT)}...` : text
  } catch {
    return ''
  }
}

/**
 * Validate the ingestion response shape.
 *
 * Strict on purpose. A 200 carrying nonsense would otherwise be counted as a
 * successful send, and the receipts it claimed to store would silently not exist.
 */
function parseIngestResponse(payload: unknown): IngestResponse {
  if (typeof payload !== 'object' || payload === null) {
    throw new IngestProtocolError('body was not a JSON object')
  }

  const record = payload as Record<string, unknown>
  const accepted = record['accepted']
  const rejected = record['rejected']
  const receipts = record['receipts']

  if (typeof accepted !== 'number' || typeof rejected !== 'number') {
    throw new IngestProtocolError('missing numeric accepted/rejected counts')
  }
  if (!Array.isArray(receipts) || receipts.some((id) => typeof id !== 'string')) {
    throw new IngestProtocolError('missing receipts array')
  }

  return { accepted, rejected, receipts: receipts as string[] }
}

/**
 * POST one batch. Rejects if it exceeds `MAX_EVENTS_PER_BATCH`.
 *
 * @throws {IngestHttpError} on a non-2xx status.
 * @throws {IngestProtocolError} on an unusable response body.
 * @throws whatever the transport throws on a network failure.
 */
export async function postIngestBatch(
  events: readonly IngestEvent[],
  options: CloudIngestOptions,
): Promise<IngestResponse> {
  if (events.length === 0) return { accepted: 0, rejected: 0, receipts: [] }

  if (events.length > MAX_EVENTS_PER_BATCH) {
    throw new Error(`refusing to post ${events.length} events: the maximum per batch is ${MAX_EVENTS_PER_BATCH}`)
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation available for cloud ingestion')
  }

  const body: IngestRequest = { events: [...events] }

  const response = await fetchImpl(joinUrl(options.endpoint, INGEST_PATH), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': options.apiKey,
      ...options.headers,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new IngestHttpError(response.status, await readErrorSnippet(response))
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new IngestProtocolError(`body was not valid JSON (${detail})`)
  }

  return parseIngestResponse(payload)
}

/**
 * Build the transport the queue sends through.
 *
 * Splits anything larger than `MAX_EVENTS_PER_BATCH` into chunks and posts them in
 * order, stopping at the first failure. A failure therefore rethrows for the whole
 * batch, and the queue's retry re-posts the earlier chunks too - which is safe,
 * because backend ingestion is idempotent on `receiptId`.
 */
export function createIngestTransport(options: CloudIngestOptions): IngestTransport {
  return async (batch: readonly IngestEvent[]): Promise<void> => {
    const events = [...batch]

    for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_BATCH) {
      const chunk = events.slice(offset, offset + MAX_EVENTS_PER_BATCH)

      try {
        await postIngestBatch(chunk, options)
      } catch (error) {
        try {
          options.onError?.(error, chunk)
        } catch {
          // A broken diagnostic callback must not replace the real error.
        }
        throw error
      }
    }
  }
}
