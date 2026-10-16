/**
 * Cloud ingestion tests.
 *
 * `postIngestBatch` deliberately THROWS on failure, because the queue needs to see
 * failures in order to count them. So the "never throws into the caller" guarantee
 * is tested at the seam that matters: a queue wired to this transport must swallow
 * everything, and the enqueuing caller must never see an exception or a rejected
 * promise.
 *
 * The retry/backoff/breaker assertions live in `queue.test.ts`; here it is enough to
 * confirm this module does not duplicate them.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  INGEST_PATH,
  IngestHttpError,
  IngestProtocolError,
  createIngestTransport,
  postIngestBatch,
} from '../src/cloud.js'
import type { FetchLike } from '../src/intercept.js'
import { TelemetryQueue, type DropEvent } from '../src/queue.js'
import { MAX_EVENTS_PER_BATCH, type IngestEvent, type IngestRequest } from '../src/types.js'

const ENDPOINT = 'https://api.mstamp.test'

function makeEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    eventId: 'evt_0000000000000000001',
    receiptId: 'rcpt_0000000000000000001',
    timestamp: '2026-10-13T09:30:00.000Z',
    latencyMs: 137,
    request: {
      method: 'POST',
      url: 'https://api.scraper-x.example/v1/extract',
      headers: { 'content-type': 'application/json' },
      bodyHash: `sha256:${'a'.repeat(64)}`,
      bodyPreview: null,
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyHash: `sha256:${'b'.repeat(64)}`,
      bodyPreview: null,
      contentType: 'application/json',
    },
    validation: { passed: false, rules: ['min-length:items:1'], errors: ['items: expected at least 1, got 0'] },
    metadata: {
      provider: 'scraper-x',
      operation: 'extract',
      sdkVersion: '0.1.0',
      environment: 'production',
      registration: 'hash-only',
    },
    ...overrides,
  }
}

/** A fetch stub that records request bodies and replies with a valid ingest response. */
function recordingFetch(
  bodies: IngestRequest[],
  response: Response = new Response(JSON.stringify({ accepted: 1, rejected: 0, receipts: ['rcpt_1'] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
): { fetchImpl: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []

  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as IngestRequest)
    return response.clone()
  }

  return { fetchImpl, calls }
}

describe('postIngestBatch', () => {
  it('POSTs to the ingest path with the API key and a JSON body', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl, calls } = recordingFetch(bodies)

    const result = await postIngestBatch([makeEvent()], { endpoint: ENDPOINT, apiKey: 'sk_test_123', fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ENDPOINT}${INGEST_PATH}`)
    expect(calls[0]?.init.method).toBe('POST')

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('sk_test_123')
    expect(headers['Content-Type']).toBe('application/json')

    expect(bodies[0]?.events).toHaveLength(1)
    expect(result).toEqual({ accepted: 1, rejected: 0, receipts: ['rcpt_1'] })
  })

  it('tolerates a trailing slash on the endpoint', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl, calls } = recordingFetch(bodies)

    await postIngestBatch([makeEvent()], { endpoint: `${ENDPOINT}/`, apiKey: 'k', fetchImpl })

    expect(calls[0]?.url).toBe(`${ENDPOINT}${INGEST_PATH}`)
  })

  it('merges extra headers over the defaults', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl, calls } = recordingFetch(bodies)

    await postIngestBatch([makeEvent()], {
      endpoint: ENDPOINT,
      apiKey: 'k',
      fetchImpl,
      headers: { 'X-Trace': 'abc' },
    })

    expect((calls[0]?.init.headers as Record<string, string>)['X-Trace']).toBe('abc')
  })

  it('does nothing at all for an empty batch', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl, calls } = recordingFetch(bodies)

    const result = await postIngestBatch([], { endpoint: ENDPOINT, apiKey: 'k', fetchImpl })

    expect(calls).toHaveLength(0)
    expect(result).toEqual({ accepted: 0, rejected: 0, receipts: [] })
  })

  it('refuses a batch larger than the protocol maximum', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl, calls } = recordingFetch(bodies)
    const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => makeEvent())

    await expect(postIngestBatch(tooMany, { endpoint: ENDPOINT, apiKey: 'k', fetchImpl })).rejects.toThrow(
      /maximum per batch is 100/,
    )
    expect(calls).toHaveLength(0)
  })

  it('throws IngestHttpError with the status and a body snippet on a non-2xx', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl } = recordingFetch(
      bodies,
      new Response('{"error":"quota exceeded"}', { status: 429, headers: { 'content-type': 'application/json' } }),
    )

    try {
      await postIngestBatch([makeEvent()], { endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(IngestHttpError)
      expect((error as IngestHttpError).status).toBe(429)
      expect((error as IngestHttpError).bodySnippet).toContain('quota exceeded')
    }
  })

  it('throws IngestProtocolError when the body is not JSON', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl } = recordingFetch(bodies, new Response('<html>oops</html>', { status: 200 }))

    await expect(postIngestBatch([makeEvent()], { endpoint: ENDPOINT, apiKey: 'k', fetchImpl })).rejects.toBeInstanceOf(
      IngestProtocolError,
    )
  })

  it('throws IngestProtocolError on a 200 with an unusable shape', async () => {
    // A 200 carrying nonsense would otherwise count as a successful send, and the
    // receipts it claimed to store would silently not exist.
    for (const payload of ['{}', '{"accepted":"1","rejected":0,"receipts":[]}', '{"accepted":1,"rejected":0,"receipts":[7]}', 'null']) {
      const bodies: IngestRequest[] = []
      const { fetchImpl } = recordingFetch(bodies, new Response(payload, { status: 200 }))

      await expect(
        postIngestBatch([makeEvent()], { endpoint: ENDPOINT, apiKey: 'k', fetchImpl }),
        `payload ${payload}`,
      ).rejects.toBeInstanceOf(IngestProtocolError)
    }
  })

  it('propagates a network failure unchanged, so the queue can count it', async () => {
    const boom = new Error('ECONNREFUSED')
    const fetchImpl: FetchLike = async () => {
      throw boom
    }

    await expect(postIngestBatch([makeEvent()], { endpoint: ENDPOINT, apiKey: 'k', fetchImpl })).rejects.toBe(boom)
  })

  it('throws when no fetch implementation is available', async () => {
    vi.stubGlobal('fetch', undefined)
    try {
      await expect(postIngestBatch([makeEvent()], { endpoint: ENDPOINT, apiKey: 'k' })).rejects.toThrow(
        /no fetch implementation/,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('createIngestTransport', () => {
  it('splits an oversized batch into protocol-sized chunks', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl, calls } = recordingFetch(bodies)
    const transport = createIngestTransport({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })

    const batch = Array.from({ length: 250 }, (_, i) => makeEvent({ receiptId: `rcpt_${i}` }))
    await transport(batch)

    expect(calls).toHaveLength(3)
    expect(bodies.map((b) => b.events.length)).toEqual([100, 100, 50])
  })

  it('stops at the first failing chunk and rethrows for the queue', async () => {
    const bodies: IngestRequest[] = []
    let call = 0
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as IngestRequest)
      call++
      // Second chunk fails.
      if (call === 2) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ accepted: 100, rejected: 0, receipts: [] }), { status: 200 })
    }

    const transport = createIngestTransport({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
    const batch = Array.from({ length: 250 }, (_, i) => makeEvent({ receiptId: `rcpt_${i}` }))

    await expect(transport(batch)).rejects.toBeInstanceOf(IngestHttpError)
    expect(bodies).toHaveLength(2)
  })

  it('reports the failing chunk through onError, then rethrows', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl } = recordingFetch(bodies, new Response('nope', { status: 503 }))
    const seen: { error: unknown; count: number }[] = []

    const transport = createIngestTransport({
      endpoint: ENDPOINT,
      apiKey: 'k',
      fetchImpl,
      onError: (error, events) => {
        seen.push({ error, count: events.length })
      },
    })

    await expect(transport([makeEvent()])).rejects.toBeInstanceOf(IngestHttpError)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.count).toBe(1)
  })

  it('does not let a throwing onError replace the real error', async () => {
    const bodies: IngestRequest[] = []
    const { fetchImpl } = recordingFetch(bodies, new Response('nope', { status: 503 }))
    const transport = createIngestTransport({
      endpoint: ENDPOINT,
      apiKey: 'k',
      fetchImpl,
      onError: () => {
        throw new Error('diagnostics are broken')
      },
    })

    await expect(transport([makeEvent()])).rejects.toBeInstanceOf(IngestHttpError)
  })
})

describe('fail-open seam', () => {
  it('never lets an ingest failure reach the enqueuing caller', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down')
    }
    const transport = createIngestTransport({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })

    const drops: DropEvent<IngestEvent>[] = []
    // retryAttempts: 0 keeps this about the swallow, not about retry timing.
    const queue = new TelemetryQueue<IngestEvent>({ transport, retryAttempts: 0, onDrop: (e) => drops.push(e) })

    // Synchronous and silent, exactly as the caller's request path requires.
    expect(() => {
      queue.enqueue(makeEvent())
    }).not.toThrow()

    // flush() resolves rather than rejecting, even though every send failed.
    await expect(queue.flush()).resolves.toBeUndefined()

    expect(drops).toHaveLength(1)
    expect(drops[0]?.reason).toBe('send-failed')
    expect(queue.stats.failedBatches).toBe(1)

    queue.stop()
  })

  it('delegates retry to the queue rather than retrying here', async () => {
    // One POST attempt per flush means this module does not add its own retry on top
    // of the queue's, which would silently quadruple the attempt count.
    const calls: number[] = []
    const fetchImpl: FetchLike = async () => {
      calls.push(Date.now())
      throw new Error('down')
    }
    const transport = createIngestTransport({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
    const queue = new TelemetryQueue<IngestEvent>({ transport, retryAttempts: 0 })

    queue.enqueue(makeEvent())
    await queue.flush()

    expect(calls).toHaveLength(1)
    queue.stop()
  })
})
