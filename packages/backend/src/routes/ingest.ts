/**
 * `POST /v1/ingest/batch` - turn observed calls into signed receipts.
 *
 * Shape of the contract:
 *
 *   - **One transaction per event**, so a single bad event rejects only itself. A batch
 *     sharing one transaction would mean one failure loses all 100, which contradicts
 *     the response shape's `accepted`/`rejected` split.
 *   - **Idempotent on `receiptId`.** The first write wins and is never overwritten: a
 *     receipt is a signed artefact, so a re-send must not be able to change what was
 *     signed.
 *   - **A malformed event is `rejected`, not a 500.** Bad input is the client's problem
 *     and is counted; an unreachable database is not, and is a 503 - see below.
 *
 * The one deviation from a plain `{ accepted, rejected, receipts }` response: if NOTHING
 * could be stored and the cause was infrastructure rather than bad input, the response is
 * a 503 rather than a 200. A 200 would tell the SDK the batch succeeded, so its queue
 * would never retry and the telemetry would be lost silently - the opposite of what the
 * fail-open design is for.
 */

import { MAX_EVENTS_PER_BATCH, type IngestEvent, type Receipt, type Registration, type ValidationResult } from '@mstamp/protocol'
import { Hono } from 'hono'

import { signReceipt, type SigningKey } from '../crypto/sign.js'
import { withTenant, type DbPool } from '../db/client.js'
import { insertReceipt, selectReceipt } from '../db/receipts.js'
import type { AppEnv } from '../env.js'
import { storePreviews } from '../previews.js'

const REGISTRATIONS: readonly string[] = ['full', 'hash-only', 'local']

/** The event is unusable as input. Counted as `rejected`; not an infrastructure fault. */
export class InvalidIngestEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidIngestEventError'
  }
}

export type IngestRoutesConfig = {
  readonly pool: DbPool
  readonly signer: SigningKey
  /**
   * Master key for payload preview encryption.
   *
   * Required even when no `full`-registration event ever arrives: the route cannot know
   * in advance, and a missing key would surface as a per-event `rejected` count rather
   * than as the configuration mistake it is.
   */
  readonly masterKey: Uint8Array
  /** Injected clock, so `signedAt` is deterministic in tests. */
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value === '') {
    throw new InvalidIngestEventError(`${where}.${key} must be a non-empty string`)
  }
  return value
}

function requireNumber(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidIngestEventError(`${where}.${key} must be a finite number`)
  }
  return value
}

function requireRecord(source: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = source[key]
  if (!isRecord(value)) {
    throw new InvalidIngestEventError(`${where}.${key} must be an object`)
  }
  return value
}

function requireNullableString(source: Record<string, unknown>, key: string, where: string): string | null {
  const value = source[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new InvalidIngestEventError(`${where}.${key} must be a string or null`)
  }
  return value
}

function parseStringMap(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new InvalidIngestEventError(`${where} must be an object of strings`)

  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new InvalidIngestEventError(`${where}.${key} must be a string`)
    out[key] = entry
  }
  return out
}

function parseStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidIngestEventError(`${where} must be an array of strings`)
  }
  return value as string[]
}

function parseValidation(value: unknown): ValidationResult {
  const record = isRecord(value) ? value : undefined
  if (record === undefined) throw new InvalidIngestEventError('event.validation must be an object')

  const passed = record['passed']
  if (passed !== null && typeof passed !== 'boolean') {
    throw new InvalidIngestEventError('event.validation.passed must be a boolean or null')
  }

  return {
    passed,
    rules: parseStringArray(record['rules'], 'event.validation.rules'),
    errors: parseStringArray(record['errors'], 'event.validation.errors'),
  }
}

function parseRegistration(value: unknown): Registration {
  if (typeof value !== 'string' || !REGISTRATIONS.includes(value)) {
    throw new InvalidIngestEventError(`event.metadata.registration must be one of ${REGISTRATIONS.join(', ')}`)
  }
  return value as Registration
}

/**
 * Validate one event off the wire.
 *
 * Deliberately strict and explicit. These values end up inside a signed artefact, so a
 * missing or wrongly-typed field must be caught here rather than producing a receipt
 * that attests to something malformed.
 */
export function parseIngestEvent(value: unknown): IngestEvent {
  if (!isRecord(value)) throw new InvalidIngestEventError('event must be an object')

  const request = requireRecord(value, 'request', 'event')
  const response = requireRecord(value, 'response', 'event')
  const metadata = requireRecord(value, 'metadata', 'event')

  return {
    eventId: requireString(value, 'eventId', 'event'),
    receiptId: requireString(value, 'receiptId', 'event'),
    timestamp: requireString(value, 'timestamp', 'event'),
    latencyMs: requireNumber(value, 'latencyMs', 'event'),
    request: {
      method: requireString(request, 'method', 'event.request'),
      url: requireString(request, 'url', 'event.request'),
      headers: parseStringMap(request['headers'], 'event.request.headers'),
      bodyHash: requireString(request, 'bodyHash', 'event.request'),
      bodyPreview: requireNullableString(request, 'bodyPreview', 'event.request'),
    },
    response: {
      status: requireNumber(response, 'status', 'event.response'),
      headers: parseStringMap(response['headers'], 'event.response.headers'),
      bodyHash: requireString(response, 'bodyHash', 'event.response'),
      bodyPreview: requireNullableString(response, 'bodyPreview', 'event.response'),
      contentType: typeof response['contentType'] === 'string' ? response['contentType'] : '',
    },
    validation: parseValidation(value['validation']),
    metadata: {
      provider: requireString(metadata, 'provider', 'event.metadata'),
      operation: requireString(metadata, 'operation', 'event.metadata'),
      sdkVersion: requireString(metadata, 'sdkVersion', 'event.metadata'),
      environment: typeof metadata['environment'] === 'string' ? metadata['environment'] : 'production',
      registration: parseRegistration(metadata['registration']),
    },
  }
}

// ---------------------------------------------------------------------------
// Receipt construction
// ---------------------------------------------------------------------------

/**
 * Normalise a timestamp to millisecond-precision ISO 8601.
 *
 * Not cosmetic. `timestamp` is part of the signed payload, and it round-trips through a
 * `timestamptz` column: read back and re-`toISOString`'d, a value with microsecond
 * precision would come out as different text, and verification of the reconstructed
 * receipt would fail. Normalising once, here, makes the round-trip an identity.
 */
function normaliseTimestamp(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new InvalidIngestEventError(`event.timestamp is not a parseable ISO 8601 timestamp: ${JSON.stringify(value)}`)
  }
  return new Date(parsed).toISOString()
}

export function buildReceiptDraft(event: IngestEvent, tenantId: string, keyId: string): Receipt {
  return {
    schemaVersion: '1',
    receiptId: event.receiptId,
    tenantId,
    sellerId: null,
    provider: event.metadata.provider,
    operation: event.metadata.operation,
    requestHash: event.request.bodyHash,
    responseHash: event.response.bodyHash,
    statusCode: event.response.status,
    latencyMs: event.latencyMs,
    timestamp: normaliseTimestamp(event.timestamp),
    registration: event.metadata.registration,
    // The backend signs, so this is the one place `platform` is truthful. The SDK writes
    // `self` for its local draft precisely because it has not been signed yet.
    attestation: 'platform',
    validation: event.validation,
    anomaly: null,
    buyerOverride: null,
    sdkVersion: event.metadata.sdkVersion,
    keyId,
    serverSignature: null,
    signedAt: null,
  }
}

/** Sign one event and store it, returning what is actually in the database. */
async function signAndStore(config: IngestRoutesConfig, tenantId: string, event: IngestEvent): Promise<Receipt> {
  const draft = buildReceiptDraft(event, tenantId, config.signer.keyId)

  const { serverSignature, signedAt } = await signReceipt(
    draft,
    config.signer,
    config.now === undefined ? {} : { now: config.now },
  )

  const receipt: Receipt = { ...draft, serverSignature, signedAt }

  const stored = await withTenant(config.pool, tenantId, async (tx) => {
    await insertReceipt(tx, receipt)

    // Previews are encrypted and stored only for `full` registration; `storePreviews`
    // re-checks that rather than trusting the event, because the point of `hash-only` is
    // that previews never leave the process. Same transaction, so a receipt and its
    // preview either both land or neither does.
    await storePreviews(tx, {
      masterKey: config.masterKey,
      tenantId,
      receiptId: receipt.receiptId,
      registration: receipt.registration,
      previews: {
        request: event.request.bodyPreview,
        response: event.response.bodyPreview,
      },
    })

    // Read back rather than returning what we built: on a duplicate the row already
    // there wins, and the response should describe what was stored, not what we tried.
    return selectReceipt(tx, receipt.receiptId)
  })

  if (stored === null) {
    throw new Error(`receipt ${receipt.receiptId} was not stored`)
  }

  return stored
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function ingestRoutes(config: IngestRoutesConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.post('/batch', async (c) => {
    const tenant = c.get('tenant')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const events = isRecord(body) ? body['events'] : undefined
    if (!Array.isArray(events)) {
      return c.json({ error: 'invalid_body', detail: 'expected { events: [...] }' }, 400)
    }

    if (events.length > MAX_EVENTS_PER_BATCH) {
      return c.json({ error: 'batch_too_large', max: MAX_EVENTS_PER_BATCH, received: events.length }, 413)
    }

    if (events.length === 0) {
      return c.json({ accepted: 0, rejected: 0, receipts: [] })
    }

    const receipts: string[] = []
    let rejected = 0
    let infrastructureFailure = false

    for (const raw of events) {
      try {
        const event = parseIngestEvent(raw)
        const stored = await signAndStore(config, tenant.id, event)
        receipts.push(stored.receiptId)
      } catch (error) {
        rejected += 1
        if (!(error instanceof InvalidIngestEventError)) infrastructureFailure = true

        try {
          config.onError?.(error)
        } catch {
          // Diagnostics must never affect the response.
        }
      }
    }

    if (receipts.length === 0 && infrastructureFailure) {
      // Nothing was stored and it was not the client's fault. Answering 200 would tell
      // the SDK's queue the batch succeeded, so it would never retry.
      return c.json({ error: 'storage_unavailable', accepted: 0, rejected, receipts: [] }, 503)
    }

    return c.json({ accepted: receipts.length, rejected, receipts })
  })

  return routes
}
