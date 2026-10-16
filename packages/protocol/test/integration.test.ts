/**
 * End-to-end integration test: the whole SDK pipeline in one call.
 *
 * This is the test the original spec asks for - a fake scraper returning `{"items": []}`
 * validated with `min-length:items:1`, asserting the receipt records a failure - but
 * it deliberately checks the seams too, because the pipeline crosses four modules:
 *
 *   intercept -> validate -> local-db -> queue -> cloud
 *
 * The assertions that matter most are the ones about what the CALLER observes: their
 * response must arrive intact, byte for byte, regardless of everything the SDK does
 * around it. Telemetry that quietly changes the response is worse than no telemetry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FetchLike } from '../src/intercept.js'
import { SENTINELS, isHash } from '../src/hash.js'
import { Telemetry, type TelemetryConfig } from '../src/telemetry.js'
import type { IngestEvent, IngestRequest, Receipt } from '../src/types.js'

/** The silent failure this product exists to catch: 200 OK, empty payload. */
const SCRAPER_BODY = '{"items":[]}'

const created: Telemetry[] = []

afterEach(() => {
  for (const telemetry of created) telemetry.close()
  created.length = 0
})

function makeTelemetry(overrides: Partial<TelemetryConfig> = {}): Telemetry {
  const telemetry = new Telemetry({
    mode: 'local',
    defaultRegistration: 'hash-only',
    sdkVersion: '0.1.0',
    localDbPath: ':memory:',
    defaultProvider: 'scraper-x',
    defaultOperation: 'extract',
    registrationPolicy: { 'scraper-x': 'hash-only' },
    queueOptions: { retryAttempts: 0, telemetryTimeoutMs: 200, maxQueueSize: 100 },
    ...overrides,
  })
  created.push(telemetry)
  return telemetry
}

/** The provider under test: always 200, always empty. */
function fakeScraper(): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (input) => {
    calls.push(String(input))
    return new Response(SCRAPER_BODY, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

/** The mstamp backend stand-in: records what the SDK posted. */
function fakeBackend(): { cloudFetch: FetchLike; posts: IngestRequest[] } {
  const posts: IngestRequest[] = []
  const cloudFetch: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as IngestRequest
    posts.push(body)
    return new Response(
      JSON.stringify({ accepted: body.events.length, rejected: 0, receipts: body.events.map((e) => e.receiptId) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { cloudFetch, posts }
}

async function receiptFrom(telemetry: Telemetry): Promise<Receipt> {
  await vi.waitFor(
    () => {
      expect(telemetry.localStore?.count() ?? 0).toBe(1)
    },
    { timeout: 3000 },
  )
  return telemetry.localStore!.list()[0]!
}

async function eventFrom(posts: IngestRequest[]): Promise<IngestEvent> {
  await vi.waitFor(
    () => {
      expect(posts).toHaveLength(1)
    },
    { timeout: 3000 },
  )
  return posts[0]!.events[0]!
}

// ---------------------------------------------------------------------------
// The required scenario
// ---------------------------------------------------------------------------

describe('the silent-failure scenario', () => {
  it('records validation.passed false with a useful error', async () => {
    const { fetchImpl } = fakeScraper()
    const telemetry = makeTelemetry()

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', undefined, {
      provider: 'scraper-x',
      operation: 'extract',
      rules: ['min-length:items:1'],
    })

    const receipt = await receiptFrom(telemetry)

    // The whole point: a 200 OK that delivered nothing usable.
    expect(receipt.statusCode).toBe(200)
    expect(receipt.validation.passed).toBe(false)

    // The error has to be actionable on its own, without the payload.
    expect(receipt.validation.errors).toEqual(['items: expected at least 1, got 0'])
    expect(receipt.validation.rules).toEqual(['min-length:items:1'])
  })

  it('leaves the caller\'s response completely intact', async () => {
    const { fetchImpl } = fakeScraper()
    const telemetry = makeTelemetry()

    const response = await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', undefined, {
      rules: ['min-length:items:1'],
    })

    // Same status, same headers, same bytes - the SDK read the body via a tee and
    // the caller still gets all of it.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.text()).toBe(SCRAPER_BODY)
  })

  it('hashes the empty-items response for real, so it can be recomputed later', async () => {
    const { fetchImpl } = fakeScraper()
    const telemetry = makeTelemetry()

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', undefined, {
      rules: ['min-length:items:1'],
    })

    const receipt = await receiptFrom(telemetry)
    const { hashRawBytes } = await import('../src/hash.js')

    expect(receipt.responseHash).toBe(hashRawBytes(new TextEncoder().encode(SCRAPER_BODY)))
    expect(receipt.requestHash).toBe((await import('../src/hash.js')).hashCanonicalJson(null))
  })
})

// ---------------------------------------------------------------------------
// Local vs cloud
// ---------------------------------------------------------------------------

describe('local mode', () => {
  it('writes to SQLite and does NOT POST', async () => {
    const { fetchImpl } = fakeScraper()
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({ mode: 'local', cloudFetch })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', undefined, {
      rules: ['min-length:items:1'],
    })

    const receipt = await receiptFrom(telemetry)
    expect(receipt.validation.passed).toBe(false)

    await telemetry.flush()
    expect(posts).toHaveLength(0)
    expect(telemetry.queue).toBeNull()
  })
})

describe('cloud mode', () => {
  it('writes to SQLite AND POSTs', async () => {
    const { fetchImpl } = fakeScraper()
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test_abc', cloudFetch })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', undefined, {
      rules: ['min-length:items:1'],
    })

    // Both halves happened.
    const receipt = await receiptFrom(telemetry)
    const event = await eventFrom(posts)

    expect(receipt.validation.passed).toBe(false)
    expect(event.receiptId).toBe(receipt.receiptId)
    expect(event.validation.passed).toBe(false)
    expect(event.metadata.registration).toBe('hash-only')
  })

  it('POSTs the same hashes the local receipt records', async () => {
    const { fetchImpl } = fakeScraper()
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test_abc', cloudFetch })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', {
      method: 'POST',
      body: '{"urls":["https://example.com/a"],"api_key":"sk_live_SECRET"}',
    })

    const receipt = await receiptFrom(telemetry)
    const event = await eventFrom(posts)

    // One set of hashes, computed once, used everywhere. Drift here would mean the
    // backend signs a receipt for a different call than the one stored locally.
    expect(event.request.bodyHash).toBe(receipt.requestHash)
    expect(event.response.bodyHash).toBe(receipt.responseHash)
    expect(isHash(event.request.bodyHash)).toBe(true)
    expect(isHash(event.response.bodyHash)).toBe(true)
  })

  it('sends no body previews in hash-only mode', async () => {
    const { fetchImpl } = fakeScraper()
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test_abc',
      cloudFetch,
      registrationPolicy: { 'scraper-x': 'hash-only' },
    })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', {
      method: 'POST',
      body: '{"urls":["https://example.com/a"],"api_key":"sk_live_SECRET"}',
    })

    const event = await eventFrom(posts)

    expect(event.request.bodyPreview).toBeNull()
    expect(event.response.bodyPreview).toBeNull()
    // And the secret genuinely never left the process.
    expect(JSON.stringify(posts)).not.toContain('sk_live_SECRET')
  })

  it('sends redacted previews in full mode', async () => {
    const { fetchImpl } = fakeScraper()
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test_abc',
      cloudFetch,
      registrationPolicy: { 'scraper-x': 'full' },
    })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', {
      method: 'POST',
      body: '{"urls":["https://example.com/a"],"api_key":"sk_live_SECRET"}',
    })

    const event = await eventFrom(posts)

    expect(event.request.bodyPreview).toContain('<redacted>')
    expect(event.request.bodyPreview).not.toContain('sk_live_SECRET')
    expect(event.metadata.registration).toBe('full')
  })

  it('does not POST when the provider policy resolves to local', async () => {
    const { fetchImpl } = fakeScraper()
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test_abc',
      cloudFetch,
      registrationPolicy: { 'scraper-x': 'local' },
    })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract')
    await receiptFrom(telemetry)
    await telemetry.flush()

    expect(posts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Sentinels, end to end
// ---------------------------------------------------------------------------

describe('sentinels, end to end', () => {
  it('records the unsupported-body sentinel locally and in the POST', async () => {
    const { cloudFetch, posts } = fakeBackend()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test_abc', cloudFetch })

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}'))
        controller.close()
      },
    })

    await telemetry.wrap(
      async () => new Response('{"items":[1]}', { status: 200, headers: { 'content-type': 'application/json' } }),
      'https://api.scraper-x.example/v1/extract',
      { method: 'POST', body: stream } as RequestInit,
    )

    const receipt = await receiptFrom(telemetry)
    const event = await eventFrom(posts)

    expect(receipt.requestHash).toBe(SENTINELS.unsupportedBodyType)
    expect(receipt.validation.rules).toContain('unvalidated:unsupported-body-type')
    expect(receipt.validation.passed).toBeNull()
    expect(event.request.bodyHash).toBe(SENTINELS.unsupportedBodyType)
  })

  it('records the oversize sentinel and still returns the full body to the caller', async () => {
    const bigBody = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => i) })
    const telemetry = makeTelemetry({ maxResponseBytes: 64 })

    const response = await telemetry.wrap(
      async () => new Response(bigBody, { status: 200, headers: { 'content-type': 'application/json' } }),
      'https://api.scraper-x.example/v1/extract',
    )

    const receipt = await receiptFrom(telemetry)

    expect(receipt.responseHash).toBe(SENTINELS.oversize)
    expect(receipt.validation.rules).toEqual(['unvalidated:oversize'])
    expect(receipt.validation.passed).toBeNull()

    // The cap applies to what telemetry BUFFERS, never to what the caller receives.
    expect(await response.text()).toBe(bigBody)
  })
})

// ---------------------------------------------------------------------------
// Fail-open, end to end
// ---------------------------------------------------------------------------

describe('fail-open, end to end', () => {
  it('returns the scraper response even when the backend is completely down', async () => {
    const { fetchImpl, calls } = fakeScraper()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test_abc',
      cloudFetch: async () => {
        throw new Error('backend is down')
      },
    })

    const response = await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract', undefined, {
      rules: ['min-length:items:1'],
    })

    // The primary call is untouched...
    expect(await response.text()).toBe(SCRAPER_BODY)
    expect(calls).toHaveLength(1)

    // ...the receipt is still written locally...
    const receipt = await receiptFrom(telemetry)
    expect(receipt.validation.passed).toBe(false)

    // ...and draining the queue never throws.
    await expect(telemetry.flush()).resolves.toBeUndefined()
  })

  it('never throws from enqueue, even while the breaker is open', async () => {
    const { fetchImpl } = fakeScraper()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test_abc',
      cloudFetch: async () => {
        throw new Error('down')
      },
      queueOptions: { retryAttempts: 0, telemetryTimeoutMs: 50, circuitBreakerThreshold: 1, maxQueueSize: 10 },
    })

    await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract')
    await receiptFrom(telemetry)
    await telemetry.flush()

    expect(telemetry.queue?.circuitState).toBe('open')

    // A second call with the breaker open must still return normally and still
    // produce a local receipt.
    const response = await telemetry.wrap(fetchImpl, 'https://api.scraper-x.example/v1/extract')
    expect(await response.text()).toBe(SCRAPER_BODY)

    await vi.waitFor(
      () => {
        expect(telemetry.localStore?.count() ?? 0).toBe(2)
      },
      { timeout: 3000 },
    )
  })
})
