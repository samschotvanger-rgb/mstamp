/**
 * Fail-open telemetry queue.
 *
 * The contract, in one line: **the primary API call must never be affected by
 * telemetry.** Concretely that means `enqueue` is synchronous, calls no I/O,
 * awaits nothing and never throws, and every failure mode ends in a dropped event
 * rather than back-pressure.
 *
 * The seven parameters come straight from the V1 handoff:
 *
 * | Parameter                  | Value  | Purpose                                  |
 * | -------------------------- | ------ | ---------------------------------------- |
 * | `telemetryTimeoutMs`       | 2000   | abandon a hanging send                   |
 * | `maxQueueSize`             | 1000   | bound memory                             |
 * | `dropPolicy`               | oldest | which event to lose when full            |
 * | `circuitBreakerThreshold`  | 5      | consecutive failed flushes before opening|
 * | `circuitBreakerCooldownMs` | 30000  | how long to stop trying                  |
 * | `retryAttempts`            | 1      | one retry per batch                      |
 * | `retryDelayMs`             | 500    | delay before that retry                  |
 *
 * Two decisions worth stating explicitly:
 *
 *   - **A failed batch is DROPPED, not requeued.** The handoff says "on timeout,
 *     failure, or circuit-break, drop and log locally... if the backend is down,
 *     telemetry is lost." Requeueing would convert a backend outage into unbounded
 *     memory growth and repeated retries of stale events.
 *
 *   - **While the circuit is open, `enqueue` drops immediately rather than
 *     buffering.** A long outage therefore cannot accumulate a stale backlog; the
 *     cost is losing telemetry during the outage, which is the intended trade.
 *
 * `flush()` never rejects. A caller awaiting it is waiting for an attempt to
 * finish, not for a result it must handle.
 */

import { MAX_EVENTS_PER_BATCH } from './types.js'

export type QueueDropPolicy = 'oldest' | 'newest'

export type DropReason =
  /** The buffer was full and the configured policy evicted an event. */
  | 'queue-full'
  /** The circuit breaker is open, so the event was not buffered at all. */
  | 'circuit-open'
  /** `stop()` was called. */
  | 'stopped'
  /** A batch was sent, retried, and still failed. */
  | 'send-failed'

export type DropEvent<T> = {
  readonly reason: DropReason
  readonly items: readonly T[]
  /** Present for `send-failed`: the final error, including a timeout. */
  readonly error?: unknown
}

export type CircuitState = 'closed' | 'open'

export type TelemetryQueueOptions<T> = {
  /** Sends one batch. Supplied by the caller; `cloud.ts` will provide this later. */
  transport: (batch: readonly T[]) => Promise<void>
  telemetryTimeoutMs?: number
  maxQueueSize?: number
  dropPolicy?: QueueDropPolicy
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  retryAttempts?: number
  retryDelayMs?: number
  /** Maximum items per send. Defaults to `MAX_EVENTS_PER_BATCH` (100). */
  batchSize?: number
  /** Injectable clock, for deterministic circuit-breaker tests. */
  now?: () => number
  /**
   * Called for every lost event, synchronously.
   *
   * Must not block. A throw from this handler is swallowed: a broken logging
   * callback must never reach the caller's request path.
   */
  onDrop?: (event: DropEvent<T>) => void
}

export type ResolvedQueueOptions = {
  readonly telemetryTimeoutMs: number
  readonly maxQueueSize: number
  readonly dropPolicy: QueueDropPolicy
  readonly circuitBreakerThreshold: number
  readonly circuitBreakerCooldownMs: number
  readonly retryAttempts: number
  readonly retryDelayMs: number
  readonly batchSize: number
}

export type QueueStats = {
  /** Items that reached the buffer logic, including ones later evicted. */
  readonly enqueued: number
  readonly sent: number
  readonly dropped: number
  readonly failedBatches: number
  readonly consecutiveFailures: number
  readonly circuitState: CircuitState
  /** Epoch ms at which the open circuit may be probed again; 0 when closed. */
  readonly circuitOpenUntil: number
  readonly size: number
}

/** The seven handoff parameters. `batchSize` is separate because it is derived. */
export const DEFAULT_QUEUE_OPTIONS = {
  telemetryTimeoutMs: 2000,
  maxQueueSize: 1000,
  dropPolicy: 'oldest',
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 30000,
  retryAttempts: 1,
  retryDelayMs: 500,
} as const

/** Thrown internally when a send exceeds `telemetryTimeoutMs`. */
export class QueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`transport did not settle within ${timeoutMs}ms`)
    this.name = 'QueueTimeoutError'
  }
}

export class TelemetryQueue<T> {
  #options: ResolvedQueueOptions
  #transport: (batch: readonly T[]) => Promise<void>
  #onDrop: ((event: DropEvent<T>) => void) | undefined
  #now: () => number

  #items: T[] = []
  #flushInFlight: Promise<void> | undefined
  #flushScheduled = false
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  #stopped = false

  #consecutiveFailures = 0
  #circuitOpenUntil = 0
  #counters = { enqueued: 0, sent: 0, dropped: 0, failedBatches: 0 }

  constructor(options: TelemetryQueueOptions<T>) {
    this.#transport = options.transport
    this.#onDrop = options.onDrop
    this.#now = options.now ?? ((): number => Date.now())
    this.#options = {
      telemetryTimeoutMs: options.telemetryTimeoutMs ?? DEFAULT_QUEUE_OPTIONS.telemetryTimeoutMs,
      maxQueueSize: options.maxQueueSize ?? DEFAULT_QUEUE_OPTIONS.maxQueueSize,
      dropPolicy: options.dropPolicy ?? DEFAULT_QUEUE_OPTIONS.dropPolicy,
      circuitBreakerThreshold: options.circuitBreakerThreshold ?? DEFAULT_QUEUE_OPTIONS.circuitBreakerThreshold,
      circuitBreakerCooldownMs: options.circuitBreakerCooldownMs ?? DEFAULT_QUEUE_OPTIONS.circuitBreakerCooldownMs,
      retryAttempts: options.retryAttempts ?? DEFAULT_QUEUE_OPTIONS.retryAttempts,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_QUEUE_OPTIONS.retryDelayMs,
      batchSize: options.batchSize ?? MAX_EVENTS_PER_BATCH,
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  get options(): ResolvedQueueOptions {
    return { ...this.#options }
  }

  get size(): number {
    return this.#items.length
  }

  get circuitState(): CircuitState {
    if (this.#circuitOpenUntil === 0) return 'closed'
    return this.#now() < this.#circuitOpenUntil ? 'open' : 'closed'
  }

  get stats(): QueueStats {
    return {
      enqueued: this.#counters.enqueued,
      sent: this.#counters.sent,
      dropped: this.#counters.dropped,
      failedBatches: this.#counters.failedBatches,
      consecutiveFailures: this.#consecutiveFailures,
      circuitState: this.circuitState,
      circuitOpenUntil: this.#circuitOpenUntil,
      size: this.#items.length,
    }
  }

  // -------------------------------------------------------------------------
  // Enqueue - the caller-critical path
  // -------------------------------------------------------------------------

  /**
   * Buffer one event.
   *
   * SYNCHRONOUS by design: no I/O, no `await`, no throw. It either stores the
   * event, evicts another to make room, or drops it - all in constant time on the
   * caller's stack.
   */
  enqueue(item: T): void {
    if (this.#stopped) {
      this.#reportDrop('stopped', [item])
      return
    }

    if (this.circuitState === 'open') {
      // Not buffered: during an outage the event is lost immediately rather than
      // accumulating a stale backlog.
      this.#reportDrop('circuit-open', [item])
      return
    }

    this.#counters.enqueued++

    if (this.#items.length >= this.#options.maxQueueSize) {
      if (this.#options.dropPolicy === 'newest') {
        this.#counters.dropped++
        this.#reportDrop('queue-full', [item])
        return
      }

      const evicted = this.#items.shift()
      if (evicted !== undefined) {
        this.#counters.dropped++
        this.#reportDrop('queue-full', [evicted])
      }
    }

    this.#items.push(item)
    this.#scheduleFlush()
  }

  /**
   * Register a timer to attempt a flush. Deliberately not an immediate send: the
   * enqueue path must not initiate I/O.
   */
  #scheduleFlush(): void {
    if (this.#flushScheduled || this.#flushInFlight !== undefined || this.#stopped) return

    this.#flushScheduled = true
    this.#flushTimer = setTimeout(() => {
      this.#flushScheduled = false
      this.#flushTimer = undefined
      void this.flush()
    }, 0)
  }

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  /**
   * Attempt to send everything buffered.
   *
   * Never rejects. Concurrent calls coalesce onto one in-flight send.
   */
  flush(): Promise<void> {
    if (this.#flushInFlight !== undefined) return this.#flushInFlight

    const inFlight = this.#drain().finally(() => {
      this.#flushInFlight = undefined
    })

    this.#flushInFlight = inFlight
    return inFlight
  }

  async #drain(): Promise<void> {
    while (this.#items.length > 0) {
      if (this.#stopped) return
      if (this.circuitState === 'open') return

      const batch = this.#items.splice(0, this.#options.batchSize)
      if (batch.length === 0) return

      try {
        await this.#sendWithRetry(batch)
        this.#consecutiveFailures = 0
        this.#circuitOpenUntil = 0
        this.#counters.sent += batch.length
      } catch (error) {
        this.#counters.failedBatches++
        this.#counters.dropped += batch.length
        this.#recordFailure()
        this.#reportDrop('send-failed', batch, error)
        // Drop the batch and stop; do not requeue, do not retry further.
        return
      }
    }
  }

  async #sendWithRetry(batch: readonly T[]): Promise<void> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.#options.retryAttempts; attempt++) {
      if (attempt > 0) await this.#delay(this.#options.retryDelayMs)

      try {
        // `transport(...)` is evaluated here, synchronously, before the await.
        await this.#withTimeout(this.#transport(batch))
        return
      } catch (error) {
        lastError = error
      }
    }

    throw lastError ?? new Error('transport failed')
  }

  /**
   * Reject if `promise` has not settled within `telemetryTimeoutMs`.
   *
   * Handlers are attached to `promise` rather than using `Promise.race`, so a
   * transport that settles after we gave up is still "handled" and cannot surface
   * as an unhandled rejection. The timer is cleared on every path.
   */
  #withTimeout(promise: Promise<void>): Promise<void> {
    const timeoutMs = this.#options.telemetryTimeoutMs

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new QueueTimeoutError(timeoutMs))
      }, timeoutMs)

      promise.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  #delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  #recordFailure(): void {
    this.#consecutiveFailures++
    if (this.#consecutiveFailures >= this.#options.circuitBreakerThreshold) {
      this.#circuitOpenUntil = this.#now() + this.#options.circuitBreakerCooldownMs
    }
  }

  // -------------------------------------------------------------------------
  // Teardown and diagnostics
  // -------------------------------------------------------------------------

  /** Stop accepting work and cancel any scheduled flush. Idempotent. */
  stop(): void {
    this.#stopped = true
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = undefined
    }
    this.#flushScheduled = false
  }

  #reportDrop(reason: DropReason, items: readonly T[], error?: unknown): void {
    const handler = this.#onDrop
    if (handler === undefined) return

    try {
      handler(error === undefined ? { reason, items } : { reason, items, error })
    } catch {
      // Swallowed on purpose: diagnostics must never reach the caller's request.
    }
  }
}
