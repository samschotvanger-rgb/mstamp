/**
 * `Telemetry` - the SDK entry point.
 *
 * Wires interception, redaction, hashing, validation, local storage and cloud
 * ingestion into one object. The request path is entirely in `intercept.ts`; this
 * class only does the part that needs configuration: deciding **which registration
 * mode applies**, assembling the receipt, and deciding **whether to enqueue a cloud
 * POST**.
 *
 * Two boundaries worth stating plainly:
 *
 *   - **This class never signs anything.** Receipts written locally are unsigned
 *     drafts with `attestation: "self"` and `serverSignature: null`. The backend
 *     signs, and that is when `attestation` becomes `"platform"`. Claiming
 *     `"platform"` locally would assert an attestation that has not happened yet.
 *   - **Fail-open is absolute.** Everything after the caller's `fetch` resolves runs
 *     inside the capture callback, which swallows throws; and every step here is
 *     individually guarded so a broken local database cannot stop a cloud POST, or
 *     vice versa. The caller's API call is unaffected by any of it.
 *
 * The configuration fields marked "plumbing" are additions beyond the original spec's
 * list. They exist because the specified fields alone leave no way to point at a
 * test endpoint, inject a clock, or disable local persistence.
 */

import { createIngestTransport, type CloudIngestOptions } from './cloud.js'
import { isSentinel, sentinelToRule } from './hash.js'
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  instrumentFetch,
  type CapturedCall,
  type FetchLike,
} from './intercept.js'
import { LocalReceiptStore } from './local-db.js'
import { TelemetryQueue, type DropEvent, type TelemetryQueueOptions } from './queue.js'
import type { RedactionPolicy } from './redact.js'
import type { IngestEvent, Receipt, Registration, RegistrationPolicy, TelemetryMode, ValidationResult } from './types.js'
import { validateRawBody, type SchemaLike } from './validate.js'

/** Where local receipts go by default, relative to the working directory. */
export const DEFAULT_LOCAL_DB_PATH = '.mstamp/receipts.db'

/** Where cloud events go by default. */
export const DEFAULT_ENDPOINT = 'https://api.mstamp.dev'

/** Tenant id recorded on locally-written drafts (D-014). */
export const LOCAL_TENANT_ID = 'tnt_local'

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-'

/**
 * nanoid-style identifier: URL-safe, 21 characters, from a 64-character alphabet.
 *
 * `byte & 63` is uniform here because 256 is an exact multiple of 64, so there is no
 * modulo bias to correct.
 */
export function randomId(size = 21): string {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)

  let id = ''
  for (const byte of bytes) id += ID_ALPHABET.charAt(byte & 63)
  return id
}

/** Per-call overrides. */
export type CallOptions = {
  provider?: string
  operation?: string
  /** Built-in rule specs, e.g. `['non-empty', 'min-length:items:1']`. */
  rules?: readonly string[]
  /** Optional schema; both it and the rules must pass. */
  schema?: SchemaLike
  /** Overrides the provider policy for this call. */
  registration?: Registration
}

export type TelemetryConfig = {
  mode: TelemetryMode
  /** Required in cloud mode. Never used for signing. */
  apiKey?: string
  /** Defaults to `"tnt_local"`; in cloud mode the backend resolves the real tenant. */
  tenantId?: string
  defaultRegistration: Registration
  /** Per-provider registration overrides. */
  registrationPolicy?: RegistrationPolicy
  sdkVersion: string
  /** Response body cap in bytes. Defaults to 1 MB (D-015). */
  maxResponseBytes?: number

  // --- plumbing ---
  /** Ingestion host. Defaults to `DEFAULT_ENDPOINT`. */
  endpoint?: string
  /** SQLite path. Defaults to `DEFAULT_LOCAL_DB_PATH`; use `':memory:'` in tests. */
  localDbPath?: string
  /** Inject a store, or `null` to disable local persistence entirely. */
  localStore?: LocalReceiptStore | null
  /**
   * Injected `fetch` used for the **cloud POST**.
   *
   * Distinct from the fetch that gets wrapped: `instrumentFetch()` always wraps the
   * global `fetch`, because that is the application's own transport. Injecting one
   * function for both roles would make them collide.
   */
  cloudFetch?: FetchLike
  /** Injected clock, so timestamps are deterministic in tests. */
  now?: () => number
  /** Queue overrides: batch size, timeouts, thresholds. */
  queueOptions?: Partial<TelemetryQueueOptions<IngestEvent>>
  /** Receives every dropped event. Must not throw; a throw is swallowed. */
  onDrop?: (event: DropEvent<IngestEvent>) => void
  /** Receives internal errors (local write failures, ingest errors). */
  onError?: (error: unknown) => void
  /** Default provider when a call does not name one. */
  defaultProvider?: string
  /** Default operation when a call does not name one. */
  defaultOperation?: string
  /** Recorded in `IngestEvent.metadata.environment`. Defaults to `production`. */
  environment?: string
  /** Overrides for the default redaction policy. */
  redaction?: RedactionPolicy
}

/** A call with every configurable field resolved. */
type ResolvedCall = {
  readonly provider: string
  readonly operation: string
  readonly rules: readonly string[] | undefined
  readonly schema: SchemaLike | undefined
  readonly registration: Registration
}

const UTF8_DECODER = new TextDecoder('utf-8')

export class Telemetry {
  #mode: TelemetryMode
  #apiKey: string | undefined
  #tenantId: string
  #defaultRegistration: Registration
  #registrationPolicy: RegistrationPolicy
  #sdkVersion: string
  #maxResponseBytes: number
  #endpoint: string
  #cloudFetch: FetchLike | undefined
  #now: () => number
  #defaultProvider: string
  #defaultOperation: string
  #environment: string
  #redaction: RedactionPolicy
  #onError: ((error: unknown) => void) | undefined
  #localStore: LocalReceiptStore | null
  #queue: TelemetryQueue<IngestEvent> | null

  constructor(config: TelemetryConfig) {
    // Configuration errors throw at construction, not at request time: a missing API
    // key in cloud mode is a setup mistake, and finding out about it from a silent
    // absence of receipts would be much worse.
    if (config.mode === 'cloud' && (config.apiKey === undefined || config.apiKey === '')) {
      throw new Error('Telemetry in cloud mode requires an apiKey')
    }
    if (config.sdkVersion === '') {
      throw new Error('Telemetry requires an sdkVersion')
    }

    this.#mode = config.mode
    this.#apiKey = config.apiKey
    this.#tenantId = config.tenantId ?? LOCAL_TENANT_ID
    this.#defaultRegistration = config.defaultRegistration
    this.#registrationPolicy = config.registrationPolicy ?? {}
    this.#sdkVersion = config.sdkVersion
    this.#maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    this.#endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.#cloudFetch = config.cloudFetch
    this.#now = config.now ?? ((): number => Date.now())
    this.#defaultProvider = config.defaultProvider ?? 'unknown'
    this.#defaultOperation = config.defaultOperation ?? 'request'
    this.#environment = config.environment ?? 'production'
    this.#redaction = config.redaction ?? {}
    this.#onError = config.onError

    this.#localStore =
      config.localStore === undefined
        ? new LocalReceiptStore({ path: config.localDbPath ?? DEFAULT_LOCAL_DB_PATH })
        : config.localStore

    this.#queue = this.#createQueue(config)
  }

  #createQueue(config: TelemetryConfig): TelemetryQueue<IngestEvent> | null {
    if (config.mode !== 'cloud') return null

    const ingestOptions: CloudIngestOptions = {
      endpoint: this.#endpoint,
      apiKey: this.#apiKey ?? '',
      onError: (error) => {
        this.#reportError(error)
      },
    }
    if (this.#cloudFetch !== undefined) ingestOptions.fetchImpl = this.#cloudFetch

    const queueOptions: TelemetryQueueOptions<IngestEvent> = {
      transport: createIngestTransport(ingestOptions),
      ...(config.queueOptions ?? {}),
    }

    if (config.onDrop !== undefined) queueOptions.onDrop = config.onDrop

    return new TelemetryQueue<IngestEvent>(queueOptions)
  }

  // -------------------------------------------------------------------------
  // Introspection, for the CLI and for tests
  // -------------------------------------------------------------------------

  /** The local store, or `null` when local persistence is disabled. */
  get localStore(): LocalReceiptStore | null {
    return this.#localStore
  }

  /** The cloud queue, or `null` in local mode. */
  get queue(): TelemetryQueue<IngestEvent> | null {
    return this.#queue
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * A `fetch` that records every call it makes.
   *
   * `defaults` binds provider/operation/rules for every call the returned function
   * handles. Without a provider it falls back to `defaultProvider` (or `"unknown"`),
   * which also decides which registration policy entry applies.
   */
  instrumentFetch(defaults: CallOptions = {}): FetchLike {
    // The application's own fetch, not the cloud transport's.
    const base = globalThis.fetch as FetchLike | undefined
    if (typeof base !== 'function') {
      return () => Promise.reject(new Error('no fetch implementation available'))
    }
    return this.#create(base, defaults)
  }

  /**
   * Record a single call.
   *
   * ```ts
   * await t.wrap(fetch, url, init, { provider: 'scraper-x', operation: 'extract', rules: ['min-length:items:1'] })
   * ```
   *
   * Errors from `fetchImpl` propagate unchanged, exactly as `fetch` would.
   */
  async wrap(
    fetchImpl: FetchLike,
    url: string | URL | Request,
    init?: RequestInit,
    options: CallOptions = {},
  ): Promise<Response> {
    return this.#create(fetchImpl, options)(url, init)
  }

  /** Await the in-flight cloud flush, if any. Never rejects. */
  flush(): Promise<void> {
    return this.#queue?.flush() ?? Promise.resolve()
  }

  /** Stop the queue and close the local store. Idempotent, and never throws. */
  close(): void {
    this.#queue?.stop()

    try {
      this.#localStore?.close()
    } catch {
      // Teardown must not throw: a failure here would mask whatever the caller was
      // actually doing, and there is nothing left to recover.
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #resolveRegistration(provider: string): Registration {
    return this.#registrationPolicy[provider] ?? this.#defaultRegistration
  }

  #resolveCall(call: CallOptions): ResolvedCall {
    const provider = call.provider ?? this.#defaultProvider

    return {
      provider,
      operation: call.operation ?? this.#defaultOperation,
      rules: call.rules,
      schema: call.schema,
      registration: call.registration ?? this.#resolveRegistration(provider),
    }
  }

  #create(base: FetchLike, call: CallOptions): FetchLike {
    const resolved = this.#resolveCall(call)

    return instrumentFetch({
      fetchImpl: base,
      onCapture: (capture) => {
        this.#handleCapture(capture, resolved)
      },
      // Resolved here, at wrap time, so interception can gate body previews by the
      // same registration the receipt will record. If these two disagreed, a
      // `hash-only` receipt could still carry a `full` preview.
      registration: resolved.registration,
      redaction: this.#redaction,
      maxResponseBytes: this.#maxResponseBytes,
      now: this.#now,
    })
  }

  /**
   * Turn one capture into a receipt, a local write, and possibly a cloud event.
   *
   * Called on the deferred capture tick. Every step is guarded independently: a
   * failed local write must not prevent the cloud POST, and vice versa.
   */
  #handleCapture(capture: CapturedCall, call: ResolvedCall): void {
    try {
      const validation = this.#composeValidation(capture, call)

      const receipt: Receipt = {
        schemaVersion: '1',
        receiptId: `rcpt_${randomId()}`,
        tenantId: this.#tenantId,
        sellerId: null,
        provider: call.provider,
        operation: call.operation,
        requestHash: capture.requestBodyHash,
        responseHash: capture.responseBodyHash,
        statusCode: capture.status,
        latencyMs: capture.latencyMs,
        timestamp: capture.timestamp,
        registration: call.registration,
        // Never `platform` here: nothing has been signed yet.
        attestation: 'self',
        validation,
        anomaly: null,
        buyerOverride: null,
        sdkVersion: this.#sdkVersion,
        keyId: null,
        serverSignature: null,
        signedAt: null,
      }

      this.#storeReceipt(receipt)

      if (this.#shouldEnqueue(call.registration)) {
        // Synchronous and non-throwing by contract; see TelemetryQueue.
        this.#queue?.enqueue(this.#buildEvent(receipt, capture, call))
      }
    } catch (error) {
      this.#reportError(error)
    }
  }

  /**
   * Combine response validation with the "could not validate" markers.
   *
   * A real rule failure wins over a gap: `false` is a positive finding about the
   * response and stays true even if, say, the request body was a stream. A `true`
   * would be an overclaim when part of the call went unchecked, so a gap downgrades
   * it to `null`. Nothing here ever reports `true` while an `unvalidated:` rule is
   * present.
   */
  #composeValidation(capture: CapturedCall, call: ResolvedCall): ValidationResult {
    const unvalidated: string[] = []
    if (isSentinel(capture.requestBodyHash)) unvalidated.push(sentinelToRule(capture.requestBodyHash))
    if (isSentinel(capture.responseBodyHash)) unvalidated.push(sentinelToRule(capture.responseBodyHash))

    // No retained bytes (oversize) means there is nothing to parse or validate.
    const responseValidation: ValidationResult =
      capture.responseBytes === null
        ? { passed: null, rules: [], errors: [] }
        : validateRawBody(UTF8_DECODER.decode(capture.responseBytes), {
            rules: call.rules ?? [],
            ...(call.schema === undefined ? {} : { schema: call.schema }),
            now: this.#now(),
          })

    const rules = [...responseValidation.rules, ...unvalidated]
    const errors = [...responseValidation.errors]

    let passed: boolean | null
    if (errors.length > 0) passed = false
    else if (unvalidated.length > 0) passed = null
    else passed = responseValidation.passed

    return { passed, rules, errors }
  }

  #shouldEnqueue(registration: Registration): boolean {
    return this.#mode === 'cloud' && registration !== 'local' && this.#queue !== null
  }

  #buildEvent(receipt: Receipt, capture: CapturedCall, call: ResolvedCall): IngestEvent {
    return {
      eventId: `evt_${randomId()}`,
      receiptId: receipt.receiptId,
      timestamp: receipt.timestamp,
      latencyMs: capture.latencyMs,
      request: {
        method: capture.method,
        url: capture.url,
        headers: capture.requestHeaders,
        bodyHash: capture.requestBodyHash,
        bodyPreview: capture.requestBodyPreview,
      },
      response: {
        status: capture.status,
        headers: capture.responseHeaders,
        bodyHash: capture.responseBodyHash,
        bodyPreview: capture.responseBodyPreview,
        contentType: capture.contentType,
      },
      validation: receipt.validation,
      metadata: {
        provider: call.provider,
        operation: call.operation,
        sdkVersion: this.#sdkVersion,
        environment: this.#environment,
        registration: call.registration,
      },
    }
  }

  #storeReceipt(receipt: Receipt): void {
    const store = this.#localStore
    if (store === null) return

    try {
      store.put(receipt)
    } catch (error) {
      // A store failure loses a local copy; it must not lose the cloud event too.
      this.#reportError(error)
    }
  }

  #reportError(error: unknown): void {
    const handler = this.#onError
    if (handler === undefined) return

    try {
      handler(error)
    } catch {
      // Diagnostics must never reach the caller.
    }
  }
}
