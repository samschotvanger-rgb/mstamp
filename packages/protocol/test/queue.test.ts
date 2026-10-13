/**
 * Telemetry queue tests.
 *
 * This is the component whose whole job is to be invisible: it must never slow
 * down or break the caller's primary API call, and it must lose telemetry rather
 * than apply back-pressure. So the tests here are as much about what the queue
 * REFUSES to do (never call the transport from `enqueue`, never reject a flush,
 * never exceed its bound) as about the fail-open parameters themselves.
 *
 * Fake timers drive the retry delay, the cooldown and the scheduled flush. The
 * "never blocks the caller" block deliberately uses REAL timers, because the claim
 * being tested is about wall-clock behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_QUEUE_OPTIONS, TelemetryQueue, type DropEvent } from '../src/queue.js'

describe('fail-open defaults', () => {
  it('matches every parameter the handoff specifies', () => {
    expect(DEFAULT_QUEUE_OPTIONS).toEqual({
      telemetryTimeoutMs: 2000,
      maxQueueSize: 1000,
      dropPolicy: 'oldest',
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30000,
      retryAttempts: 1,
      retryDelayMs: 500,
    })
  })

  it('actually applies those defaults', () => {
    // Asserting the constant alone would not catch a constructor that forgot one.
    const queue = new TelemetryQueue({ transport: async () => {} })
    expect(queue.options.telemetryTimeoutMs).toBe(2000)
    expect(queue.options.maxQueueSize).toBe(1000)
    expect(queue.options.dropPolicy).toBe('oldest')
    expect(queue.options.circuitBreakerThreshold).toBe(5)
    expect(queue.options.circuitBreakerCooldownMs).toBe(30000)
    expect(queue.options.retryAttempts).toBe(1)
    expect(queue.options.retryDelayMs).toBe(500)
    queue.stop()
  })

  it('lets a caller override any parameter', () => {
    const queue = new TelemetryQueue({
      transport: async () => {},
      telemetryTimeoutMs: 10,
      maxQueueSize: 2,
      dropPolicy: 'newest',
      circuitBreakerThreshold: 1,
      circuitBreakerCooldownMs: 5,
      retryAttempts: 0,
      retryDelayMs: 1,
    })
    expect(queue.options).toMatchObject({
      telemetryTimeoutMs: 10,
      maxQueueSize: 2,
      dropPolicy: 'newest',
      circuitBreakerThreshold: 1,
      circuitBreakerCooldownMs: 5,
      retryAttempts: 0,
      retryDelayMs: 1,
    })
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// Capacity and drop policy
// ---------------------------------------------------------------------------

describe('capacity and drop policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the OLDEST item when full, which is the default policy', async () => {
    const batches: number[][] = []
    const queue = new TelemetryQueue<number>({
      transport: async (batch) => {
        batches.push([...batch])
      },
      maxQueueSize: 3,
    })
    expect(queue.options.dropPolicy).toBe('oldest')

    for (const n of [1, 2, 3, 4, 5]) queue.enqueue(n)

    expect(queue.size).toBe(3)
    expect(queue.stats.enqueued).toBe(5)
    expect(queue.stats.dropped).toBe(2)

    await queue.flush()
    // 1 and 2 were evicted; the three newest survive.
    expect(batches).toEqual([[3, 4, 5]])
    queue.stop()
  })

  it('drops the NEWEST item when the policy says so', async () => {
    const batches: number[][] = []
    const queue = new TelemetryQueue<number>({
      transport: async (batch) => {
        batches.push([...batch])
      },
      maxQueueSize: 3,
      dropPolicy: 'newest',
    })

    for (const n of [1, 2, 3, 4, 5]) queue.enqueue(n)

    expect(queue.size).toBe(3)
    await queue.flush()
    // The three oldest survive; the incoming items were refused.
    expect(batches).toEqual([[1, 2, 3]])
    queue.stop()
  })

  it('reports what it dropped, and why', () => {
    const drops: DropEvent<number>[] = []
    const queue = new TelemetryQueue<number>({
      transport: async () => {},
      maxQueueSize: 2,
      onDrop: (event) => {
        drops.push(event)
      },
    })

    for (const n of [1, 2, 3]) queue.enqueue(n)

    expect(drops).toEqual([{ reason: 'queue-full', items: [1] }])
    queue.stop()
  })

  it('never exceeds maxQueueSize', () => {
    const queue = new TelemetryQueue<number>({ transport: async () => {}, maxQueueSize: 10 })
    for (let i = 0; i < 500; i++) queue.enqueue(i)
    expect(queue.size).toBe(10)
    expect(queue.stats.dropped).toBe(490)
    queue.stop()
  })

  it('splits a backlog into ingest-sized batches', async () => {
    const batches: number[][] = []
    const queue = new TelemetryQueue<number>({
      transport: async (batch) => {
        batches.push([...batch])
      },
      maxQueueSize: 250,
    })
    for (let i = 0; i < 250; i++) queue.enqueue(i)

    await queue.flush()

    // MAX_EVENTS_PER_BATCH is 100, so a 250-item backlog is three batches.
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50])
    expect(queue.stats.sent).toBe(250)
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('circuit breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens after 5 consecutive failures and stops calling the transport', async () => {
    const drops: DropEvent<number>[] = []
    const transport = vi.fn(async () => {
      throw new Error('backend down')
    })
    // retryAttempts: 0 isolates the breaker from retry timing.
    const queue = new TelemetryQueue<number>({
      transport,
      retryAttempts: 0,
      onDrop: (event) => {
        drops.push(event)
      },
    })
    expect(queue.options.circuitBreakerThreshold).toBe(5)

    for (let i = 0; i < 5; i++) {
      queue.enqueue(i)
      await queue.flush()
    }

    expect(transport).toHaveBeenCalledTimes(5)
    expect(queue.circuitState).toBe('open')
    expect(queue.stats.consecutiveFailures).toBe(5)

    // While open, new items are dropped at enqueue rather than buffered, so a
    // long outage cannot accumulate a stale backlog in memory.
    queue.enqueue(99)
    expect(queue.size).toBe(0)
    expect(drops.at(-1)).toEqual({ reason: 'circuit-open', items: [99] })

    await queue.flush()
    expect(transport).toHaveBeenCalledTimes(5)
    queue.stop()
  })

  it('does not open below the threshold', async () => {
    const transport = vi.fn(async () => {
      throw new Error('down')
    })
    const queue = new TelemetryQueue<number>({ transport, retryAttempts: 0 })

    for (let i = 0; i < 4; i++) {
      queue.enqueue(i)
      await queue.flush()
    }

    expect(queue.stats.consecutiveFailures).toBe(4)
    expect(queue.circuitState).toBe('closed')
    queue.stop()
  })

  it('closes again once the cooldown has elapsed', async () => {
    let failing = true
    const transport = vi.fn(async () => {
      if (failing) throw new Error('down')
    })
    const queue = new TelemetryQueue<number>({ transport, retryAttempts: 0 })

    for (let i = 0; i < 5; i++) {
      queue.enqueue(i)
      await queue.flush()
    }
    expect(queue.circuitState).toBe('open')

    // One millisecond short of the 30s cooldown.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(queue.circuitState).toBe('open')

    await vi.advanceTimersByTimeAsync(1)
    expect(queue.circuitState).toBe('closed')

    // A half-open probe: the next send is attempted and, if it works, clears state.
    failing = false
    queue.enqueue(999)
    await queue.flush()

    expect(transport).toHaveBeenCalledTimes(6)
    expect(queue.stats.consecutiveFailures).toBe(0)
    expect(queue.stats.sent).toBe(1)
    expect(queue.circuitState).toBe('closed')
    queue.stop()
  })

  it('re-opens if the half-open probe fails', async () => {
    const transport = vi.fn(async () => {
      throw new Error('still down')
    })
    const queue = new TelemetryQueue<number>({ transport, retryAttempts: 0 })

    for (let i = 0; i < 5; i++) {
      queue.enqueue(i)
      await queue.flush()
    }
    expect(queue.circuitState).toBe('open')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(queue.circuitState).toBe('closed')

    queue.enqueue(999)
    await queue.flush()

    expect(transport).toHaveBeenCalledTimes(6)
    expect(queue.circuitState).toBe('open')
    queue.stop()
  })

  it('resets the failure count on any success', async () => {
    let failNext = 3
    const transport = vi.fn(async () => {
      if (failNext-- > 0) throw new Error('down')
    })
    const queue = new TelemetryQueue<number>({ transport, retryAttempts: 0 })

    for (let i = 0; i < 3; i++) {
      queue.enqueue(i)
      await queue.flush()
    }
    expect(queue.stats.consecutiveFailures).toBe(3)

    queue.enqueue(999)
    await queue.flush()
    expect(queue.stats.consecutiveFailures).toBe(0)

    // The counter genuinely restarted: four more failures still do not open it.
    failNext = 4
    for (let i = 0; i < 4; i++) {
      queue.enqueue(i)
      await queue.flush()
    }
    expect(queue.stats.consecutiveFailures).toBe(4)
    expect(queue.circuitState).toBe('closed')
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// Retry and timeout
// ---------------------------------------------------------------------------

describe('retry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries exactly once, 500ms later, then succeeds', async () => {
    vi.useFakeTimers()
    const callTimes: number[] = []
    const transport = vi.fn(async () => {
      callTimes.push(Date.now())
      if (callTimes.length === 1) throw new Error('transient')
    })
    const queue = new TelemetryQueue<string>({ transport })

    queue.enqueue('event')
    const flushPromise = queue.flush()
    // Let the first attempt's rejection settle so the retry delay is scheduled,
    // then advance exactly that delay.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    await flushPromise

    expect(transport).toHaveBeenCalledTimes(2)
    expect(callTimes[1]! - callTimes[0]!).toBe(500)
    expect(queue.stats.sent).toBe(1)
    expect(queue.stats.failedBatches).toBe(0)
    expect(queue.circuitState).toBe('closed')
    queue.stop()
  })

  it('does not retry when retryAttempts is 0', async () => {
    const transport = vi.fn(async () => {
      throw new Error('down')
    })
    const queue = new TelemetryQueue<string>({ transport, retryAttempts: 0 })

    queue.enqueue('event')
    await queue.flush()

    expect(transport).toHaveBeenCalledTimes(1)
    expect(queue.stats.failedBatches).toBe(1)
    queue.stop()
  })

  it('gives up after the retry also fails, dropping the batch', async () => {
    vi.useFakeTimers()
    const drops: DropEvent<string>[] = []
    const transport = vi.fn(async () => {
      throw new Error('still down')
    })
    const queue = new TelemetryQueue<string>({
      transport,
      onDrop: (event) => {
        drops.push(event)
      },
    })

    queue.enqueue('event')
    const flushPromise = queue.flush()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    await flushPromise

    expect(transport).toHaveBeenCalledTimes(2)
    // Fail-open: the batch is lost rather than retried forever or buffered.
    expect(drops).toEqual([{ reason: 'send-failed', items: ['event'], error: expect.any(Error) }])
    expect(queue.stats.dropped).toBe(1)
    expect(queue.stats.failedBatches).toBe(1)
    queue.stop()
  })
})

describe('telemetryTimeoutMs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('abandons a hanging transport after 2s by default', async () => {
    const never = new Promise<void>(() => {})
    const transport = vi.fn(() => never)
    const queue = new TelemetryQueue<string>({ transport, retryAttempts: 0 })

    queue.enqueue('event')
    const flushPromise = queue.flush()

    await vi.advanceTimersByTimeAsync(1999)
    expect(queue.stats.failedBatches).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await flushPromise

    expect(queue.stats.failedBatches).toBe(1)
    expect(queue.stats.dropped).toBe(1)
    queue.stop()
  })

  it('never rejects a flush, so a failing send cannot break the caller', async () => {
    const transport = vi.fn(async () => {
      throw new Error('down')
    })
    const queue = new TelemetryQueue<string>({ transport, retryAttempts: 0 })

    queue.enqueue('event')
    await expect(queue.flush()).resolves.toBeUndefined()
    queue.stop()
  })

  it('coalesces concurrent flushes into one in-flight send', async () => {
    const transport = vi.fn(async () => {})
    const queue = new TelemetryQueue<string>({ transport })

    queue.enqueue('a')
    await Promise.all([queue.flush(), queue.flush(), queue.flush()])

    expect(transport).toHaveBeenCalledTimes(1)
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// Scheduled (self-driving) flush
// ---------------------------------------------------------------------------

describe('scheduled flush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes on its own, with no action from the caller', async () => {
    const batches: string[][] = []
    const queue = new TelemetryQueue<string>({
      transport: async (batch) => {
        batches.push([...batch])
      },
    })

    queue.enqueue('a')
    expect(batches).toEqual([])

    await vi.advanceTimersByTimeAsync(0)
    expect(batches).toEqual([['a']])
    queue.stop()
  })

  it('coalesces many enqueues into a single flush', async () => {
    const transport = vi.fn(async () => {})
    const queue = new TelemetryQueue<string>({ transport })

    for (let i = 0; i < 50; i++) queue.enqueue(`e${i}`)
    await vi.advanceTimersByTimeAsync(0)

    expect(transport).toHaveBeenCalledTimes(1)
    expect(queue.stats.sent).toBe(50)
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// Never blocking the caller
// ---------------------------------------------------------------------------

describe('never blocks the caller', () => {
  // Real timers: the claim under test is about wall-clock behaviour.
  it('enqueue returns undefined, not a promise', () => {
    const queue = new TelemetryQueue<string>({ transport: async () => {} })
    expect(queue.enqueue('event')).toBeUndefined()
    queue.stop()
  })

  it('enqueue is a synchronous function, so it cannot contain an await', () => {
    const queue = new TelemetryQueue<string>({ transport: async () => {} })
    expect(queue.enqueue.constructor.name).not.toBe('AsyncFunction')
    queue.stop()
  })

  it('does not touch the transport on the enqueue path', () => {
    const transport = vi.fn(async () => {})
    const queue = new TelemetryQueue<string>({ transport })

    queue.enqueue('a')
    queue.enqueue('b')

    // No I/O has been initiated; the flush is deferred to a timer.
    expect(transport).not.toHaveBeenCalled()
    expect(queue.size).toBe(2)
    queue.stop()
  })

  it('enqueues a full 1000-item buffer against a hanging transport without yielding', () => {
    const hanging = vi.fn(() => new Promise<void>(() => {}))
    const queue = new TelemetryQueue<number>({ transport: hanging, maxQueueSize: 1000 })

    const started = performance.now()
    for (let i = 0; i < 1000; i++) queue.enqueue(i)
    const elapsed = performance.now() - started

    expect(hanging).not.toHaveBeenCalled()
    expect(queue.size).toBe(1000)
    // Generous bound. A synchronous loop over 1000 items is microseconds; this
    // would blow up immediately if enqueue ever awaited anything.
    expect(elapsed).toBeLessThan(100)
    queue.stop()
  })

  it('accepts new work while a send is in flight', async () => {
    // Both sends await one shared gate, so resolving it drains the whole queue and
    // this test measures responsiveness rather than the 2s timeout path.
    let openGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const transport = vi.fn(() => gate)
    const queue = new TelemetryQueue<string>({ transport, retryAttempts: 0, maxQueueSize: 10 })

    queue.enqueue('first')
    const flushPromise = queue.flush()
    expect(transport).toHaveBeenCalledTimes(1)

    // A send is in flight and unresolved. Enqueue must still return instantly and
    // the item must land in the buffer rather than being lost or blocking.
    const started = performance.now()
    expect(queue.enqueue('second')).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(50)
    expect(queue.size).toBe(1)

    openGate?.()
    await flushPromise

    expect(transport).toHaveBeenCalledTimes(2)
    expect(queue.stats.sent).toBe(2)
    queue.stop()
  })
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('drops anything enqueued after stop, with a reason', () => {
    const drops: DropEvent<string>[] = []
    const queue = new TelemetryQueue<string>({
      transport: async () => {},
      onDrop: (event) => {
        drops.push(event)
      },
    })

    queue.stop()
    queue.enqueue('late')

    expect(queue.size).toBe(0)
    expect(drops).toEqual([{ reason: 'stopped', items: ['late'] }])
  })

  it('cancels a scheduled flush', async () => {
    vi.useFakeTimers()
    const transport = vi.fn(async () => {})
    const queue = new TelemetryQueue<string>({ transport })

    queue.enqueue('a')
    queue.stop()
    await vi.advanceTimersByTimeAsync(5000)

    expect(transport).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Diagnostics must never leak into the caller
// ---------------------------------------------------------------------------

describe('diagnostic callbacks', () => {
  it('does not let a throwing onDrop break enqueue', () => {
    const queue = new TelemetryQueue<string>({
      transport: async () => {},
      maxQueueSize: 1,
      onDrop: () => {
        throw new Error('logging is broken')
      },
    })

    expect(() => {
      queue.enqueue('a')
      queue.enqueue('b')
    }).not.toThrow()
    queue.stop()
  })
})
