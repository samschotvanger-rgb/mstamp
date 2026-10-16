/**
 * `Telemetry` tests.
 *
 * The class is mostly glue, so these tests mostly check the decisions glue has to
 * make: which registration applies, what ends up in the receipt, whether a cloud
 * POST is enqueued at all, and that no single failure can take down another step.
 *
 * Captures are deferred by design (that is the whole point of `intercept.ts`), so
 * every test waits via `vi.waitFor` rather than a fixed sleep.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SENTINELS, isHash, isSentinel } from '../src/hash.js'
import type { FetchLike } from '../src/intercept.js'
import type { LocalReceiptStore } from '../src/local-db.js'
import { LOCAL_TENANT_ID, Telemetry, randomId, type TelemetryConfig } from '../src/telemetry.js'
import type { IngestEvent, IngestRequest, Receipt } from '../src/types.js'

const created: Telemetry[] = []

function makeTelemetry(overrides: Partial<TelemetryConfig> = {}): Telemetry {
  const telemetry = new Telemetry({
    mode: 'local',
    defaultRegistration: 'hash-only',
    sdkVersion: '0.1.0-test',
    localDbPath: ':memory:',
    defaultProvider: 'scraper-x',
    defaultOperation: 'extract',
    // Required in cloud mode. Harmless in local mode, and it keeps the cloud-mode
    // overrides in this file from having to repeat it at every call site.
    endpoint: 'https://ingest.test',
    // Short timeouts keep failure paths fast without weakening queue.test.ts, which
    // owns the real timing assertions.
    queueOptions: { retryAttempts: 0, telemetryTimeoutMs: 100, maxQueueSize: 100 },
    ...overrides,
  })
  created.push(telemetry)
  return telemetry
}

afterEach(() => {
  // Splice first. If a `close()` threw, leaving entries in the array would make
  // every later test fail in its own afterEach with a confusing cascade.
  for (const telemetry of created.splice(0)) telemetry.close()
})

function scraperFetch(body = '{"items":[1,2,3]}', status = 200): FetchLike {
  return async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** A cloud fetch stub that records posted bodies. */
function cloudSpy(): { cloudFetch: FetchLike; bodies: IngestRequest[] } {
  const bodies: IngestRequest[] = []

  const cloudFetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as IngestRequest)
    return new Response(JSON.stringify({ accepted: bodies.at(-1)?.events.length ?? 0, rejected: 0, receipts: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { cloudFetch, bodies }
}

/** Wait for `count` receipts to land in the local store, then return them. */
async function receiptsOf(telemetry: Telemetry, count = 1): Promise<Receipt[]> {
  await vi.waitFor(
    () => {
      expect(telemetry.localStore?.count() ?? 0).toBe(count)
    },
    { timeout: 3000 },
  )
  return telemetry.localStore?.list() ?? []
}

async function waitForPosts(bodies: IngestRequest[], count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(bodies).toHaveLength(count)
    },
    { timeout: 3000 },
  )
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('construction', () => {
  it('throws when cloud mode has no API key', () => {
    // Setup errors should be loud. Finding out about a missing key from a silent
    // absence of receipts would be far worse.
    expect(() => new Telemetry({ mode: 'cloud', defaultRegistration: 'hash-only', sdkVersion: '0.1.0' })).toThrow(
      /requires an apiKey/,
    )
  })

  it('throws when cloud mode has no endpoint', () => {
    // There is no default endpoint on purpose. A library-supplied hostname would send
    // every caller's telemetry to a domain the caller does not own.
    expect(
      () => new Telemetry({ mode: 'cloud', apiKey: 'sk_test', defaultRegistration: 'hash-only', sdkVersion: '0.1.0' }),
    ).toThrow(/requires an endpoint/)
  })

  it('rejects a whitespace-only endpoint in cloud mode', () => {
    expect(
      () =>
        new Telemetry({
          mode: 'cloud',
          apiKey: 'sk_test',
          endpoint: '   ',
          defaultRegistration: 'hash-only',
          sdkVersion: '0.1.0',
        }),
    ).toThrow(/requires an endpoint/)
  })

  it('does not require an endpoint in local mode, where nothing is posted', () => {
    expect(() => new Telemetry({ mode: 'local', defaultRegistration: 'local', sdkVersion: '0.1.0', localDbPath: ':memory:' })).not.toThrow()
  })

  it('throws when sdkVersion is empty', () => {
    expect(() => new Telemetry({ mode: 'local', defaultRegistration: 'local', sdkVersion: '' })).toThrow(
      /requires an sdkVersion/,
    )
  })

  it('has no cloud queue in local mode', () => {
    expect(makeTelemetry({ mode: 'local' }).queue).toBeNull()
  })

  it('has a cloud queue in cloud mode', () => {
    expect(makeTelemetry({ mode: 'cloud', apiKey: 'sk_test', cloudFetch: cloudSpy().cloudFetch }).queue).not.toBeNull()
  })

  it('defaults the tenant to tnt_local', async () => {
    const telemetry = makeTelemetry()
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')

    expect((await receiptsOf(telemetry))[0]?.tenantId).toBe(LOCAL_TENANT_ID)
  })

  it('honours a configured tenant', async () => {
    const telemetry = makeTelemetry({ tenantId: 'tnt_acme' })
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')

    expect((await receiptsOf(telemetry))[0]?.tenantId).toBe('tnt_acme')
  })

  it('can disable local persistence entirely', async () => {
    const telemetry = makeTelemetry({ localStore: null })
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')

    expect(telemetry.localStore).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Receipt assembly
// ---------------------------------------------------------------------------

describe('receipt assembly', () => {
  it('writes a receipt with the capture mirrored into it', async () => {
    const telemetry = makeTelemetry()
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract', { method: 'POST', body: '{"a":1}' })

    const receipt = (await receiptsOf(telemetry))[0]!

    expect(receipt.schemaVersion).toBe('1')
    expect(receipt.provider).toBe('scraper-x')
    expect(receipt.operation).toBe('extract')
    expect(receipt.statusCode).toBe(200)
    expect(receipt.sdkVersion).toBe('0.1.0-test')
    expect(isHash(receipt.requestHash)).toBe(true)
    expect(isHash(receipt.responseHash)).toBe(true)
    expect(receipt.receiptId.startsWith('rcpt_')).toBe(true)
  })

  it('never claims a platform attestation, because nothing has been signed yet', async () => {
    const telemetry = makeTelemetry()
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')

    const receipt = (await receiptsOf(telemetry))[0]!

    expect(receipt.attestation).toBe('self')
    expect(receipt.keyId).toBeNull()
    expect(receipt.serverSignature).toBeNull()
    expect(receipt.signedAt).toBeNull()
  })

  it('leaves the reserved V2 fields null', async () => {
    const telemetry = makeTelemetry()
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')

    const receipt = (await receiptsOf(telemetry))[0]!
    expect(receipt.anomaly).toBeNull()
    expect(receipt.buyerOverride).toBeNull()
  })

  it('takes provider and operation from per-call options', async () => {
    const telemetry = makeTelemetry()
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract', undefined, {
      provider: 'other-provider',
      operation: 'fetch-page',
    })

    const receipt = (await receiptsOf(telemetry))[0]!
    expect(receipt.provider).toBe('other-provider')
    expect(receipt.operation).toBe('fetch-page')
  })

  it('falls back to "unknown" when no provider is configured or given', async () => {
    const telemetry = new Telemetry({
      mode: 'local',
      defaultRegistration: 'local',
      sdkVersion: '0.1.0-test',
      localDbPath: ':memory:',
      queueOptions: { retryAttempts: 0 },
    })
    created.push(telemetry)

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')
    expect((await receiptsOf(telemetry))[0]?.provider).toBe('unknown')
  })

  it('records the validation verdict from the response body', async () => {
    const telemetry = makeTelemetry()
    await telemetry.wrap(scraperFetch('{"items":[]}'), 'https://api.example.com/v1/extract', undefined, {
      rules: ['min-length:items:1'],
    })

    const receipt = (await receiptsOf(telemetry))[0]!
    expect(receipt.validation.passed).toBe(false)
    expect(receipt.validation.errors[0]).toBe('items: expected at least 1, got 0')
  })

  it('propagates the caller\'s fetch error and writes nothing', async () => {
    const boom = new Error('network down')
    const failing: FetchLike = async () => {
      throw boom
    }
    const telemetry = makeTelemetry()

    await expect(telemetry.wrap(failing, 'https://api.example.com/v1/extract')).rejects.toBe(boom)

    // Give the deferred queue a chance to (not) run.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(telemetry.localStore?.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration resolution', () => {
  it('uses the default registration', async () => {
    const telemetry = makeTelemetry({ defaultRegistration: 'full' })
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/extract')

    expect((await receiptsOf(telemetry))[0]?.registration).toBe('full')
  })

  it('lets a per-provider policy override the default', async () => {
    const telemetry = makeTelemetry({
      defaultRegistration: 'hash-only',
      registrationPolicy: { 'scraper-x': 'local', 'pii-api': 'hash-only' },
    })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x', undefined, { provider: 'scraper-x' })
    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/y', undefined, { provider: 'pii-api' })

    const receipts = await receiptsOf(telemetry, 2)
    const byProvider = Object.fromEntries(receipts.map((r) => [r.provider, r.registration]))
    expect(byProvider).toEqual({ 'scraper-x': 'local', 'pii-api': 'hash-only' })
  })

  it('lets a per-call override win over the policy', async () => {
    const telemetry = makeTelemetry({
      defaultRegistration: 'hash-only',
      registrationPolicy: { 'scraper-x': 'local' },
    })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x', undefined, { registration: 'full' })
    expect((await receiptsOf(telemetry))[0]?.registration).toBe('full')
  })

  it('produces no body previews in hash-only mode', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test',
      cloudFetch,
      defaultRegistration: 'hash-only',
    })

    await telemetry.wrap(scraperFetch('{"email":"a@b.com"}'), 'https://api.example.com/v1/x', {
      method: 'POST',
      body: '{"email":"a@b.com"}',
    })
    await waitForPosts(bodies, 1)

    const event = bodies[0]!.events[0]!
    expect(event.request.bodyPreview).toBeNull()
    expect(event.response.bodyPreview).toBeNull()
    expect(event.metadata.registration).toBe('hash-only')
  })

  it('produces redacted previews in full mode', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test', cloudFetch, defaultRegistration: 'full' })

    await telemetry.wrap(scraperFetch('{"email":"a@b.com"}'), 'https://api.example.com/v1/x', {
      method: 'POST',
      body: '{"email":"a@b.com","q":"shoes"}',
    })
    await waitForPosts(bodies, 1)

    const event = bodies[0]!.events[0]!
    expect(event.request.bodyPreview).toContain('<redacted>')
    expect(event.request.bodyPreview).not.toContain('a@b.com')
    expect(event.response.bodyPreview).toContain('<redacted>')
  })
})

// ---------------------------------------------------------------------------
// Cloud enqueueing
// ---------------------------------------------------------------------------

describe('cloud enqueueing', () => {
  it('never POSTs in local mode', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const telemetry = makeTelemetry({ mode: 'local', cloudFetch })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')
    await receiptsOf(telemetry)
    await telemetry.flush()

    expect(bodies).toHaveLength(0)
    expect(telemetry.queue).toBeNull()
  })

  it('POSTs in cloud mode', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test', cloudFetch })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')
    await waitForPosts(bodies, 1)

    const event = bodies[0]!.events[0]! as IngestEvent
    expect(event.receiptId.startsWith('rcpt_')).toBe(true)
    expect(event.eventId.startsWith('evt_')).toBe(true)
    expect(event.metadata.provider).toBe('scraper-x')
    expect(event.metadata.sdkVersion).toBe('0.1.0-test')
    expect(event.metadata.environment).toBe('production')
  })

  it('does not POST when the resolved registration is local, even in cloud mode', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test',
      cloudFetch,
      registrationPolicy: { 'scraper-x': 'local' },
    })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')
    await receiptsOf(telemetry)
    await telemetry.flush()

    expect(bodies).toHaveLength(0)
  })

  it('still writes the receipt locally in cloud mode', async () => {
    const { cloudFetch } = cloudSpy()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test', cloudFetch })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')

    expect(await receiptsOf(telemetry)).toHaveLength(1)
  })

  it('records the configured environment', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const telemetry = makeTelemetry({ mode: 'cloud', apiKey: 'sk_test', cloudFetch, environment: 'development' })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')
    await waitForPosts(bodies, 1)

    expect(bodies[0]!.events[0]!.metadata.environment).toBe('development')
  })
})

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

describe('sentinels', () => {
  it('marks an unsupported request body type and reports it as unvalidated', async () => {
    const telemetry = makeTelemetry()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}'))
        controller.close()
      },
    })

    await telemetry.wrap(scraperFetch('{"items":[1]}'), 'https://api.example.com/v1/x', {
      method: 'POST',
      body: stream,
    } as RequestInit)

    const receipt = (await receiptsOf(telemetry))[0]!

    expect(receipt.requestHash).toBe(SENTINELS.unsupportedBodyType)
    // A sentinel must never wear a hash prefix.
    expect(isHash(receipt.requestHash)).toBe(false)
    expect(isSentinel(receipt.requestHash)).toBe(true)
    expect(receipt.validation.rules).toContain('unvalidated:unsupported-body-type')
    expect(receipt.validation.passed).toBeNull()
    // The response itself was still hashed for real.
    expect(isHash(receipt.responseHash)).toBe(true)
  })

  it('marks an oversized response and reports it as unvalidated', async () => {
    const telemetry = makeTelemetry({ maxResponseBytes: 16 })

    await telemetry.wrap(scraperFetch('{"items":[1,2,3,4,5,6,7,8,9,10]}'), 'https://api.example.com/v1/x')

    const receipt = (await receiptsOf(telemetry))[0]!

    expect(receipt.responseHash).toBe(SENTINELS.oversize)
    expect(isHash(receipt.responseHash)).toBe(false)
    expect(receipt.validation.rules).toContain('unvalidated:oversize')
    expect(receipt.validation.passed).toBeNull()
    // Nothing was parsed, so no rules could have run.
    expect(receipt.validation.errors).toEqual([])
  })

  it('records both sentinels when both apply', async () => {
    const telemetry = makeTelemetry({ maxResponseBytes: 8 })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}'))
        controller.close()
      },
    })

    await telemetry.wrap(scraperFetch('{"items":[1,2,3,4,5]}'), 'https://api.example.com/v1/x', {
      method: 'POST',
      body: stream,
    } as RequestInit)

    const receipt = (await receiptsOf(telemetry))[0]!
    expect(receipt.validation.rules).toEqual(
      expect.arrayContaining(['unvalidated:unsupported-body-type', 'unvalidated:oversize']),
    )
    expect(receipt.validation.passed).toBeNull()
  })

  it('lets a real rule failure win over an unvalidated gap', async () => {
    // `false` is a positive finding about the response and stays true even though
    // part of the call went unchecked. Reporting `null` here would hide a real
    // failure; reporting `true` would be the overclaim.
    const telemetry = makeTelemetry()
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    await telemetry.wrap(
      scraperFetch('{"items":[]}'),
      'https://api.example.com/v1/x',
      { method: 'POST', body: stream } as RequestInit,
      { rules: ['min-length:items:1'] },
    )

    const receipt = (await receiptsOf(telemetry))[0]!
    expect(receipt.validation.passed).toBe(false)
    expect(receipt.validation.errors[0]).toBe('items: expected at least 1, got 0')
    expect(receipt.validation.rules).toContain('unvalidated:unsupported-body-type')
  })

  it('never reports a passing verdict while an unvalidated rule is present', async () => {
    const telemetry = makeTelemetry()
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    await telemetry.wrap(scraperFetch('{"items":[1]}'), 'https://api.example.com/v1/x', {
      method: 'POST',
      body: stream,
    } as RequestInit)

    const receipt = (await receiptsOf(telemetry))[0]!
    expect(receipt.validation.passed).not.toBe(true)
    expect(receipt.validation.passed).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

describe('resilience', () => {
  it('does not let a broken local store stop the cloud POST', async () => {
    const { cloudFetch, bodies } = cloudSpy()
    const errors: unknown[] = []
    const brokenStore = {
      put: () => {
        throw new Error('disk full')
      },
      close: () => {},
    } as unknown as LocalReceiptStore

    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test',
      cloudFetch,
      localStore: brokenStore,
      onError: (error) => errors.push(error),
    })

    await telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')
    await waitForPosts(bodies, 1)

    expect(bodies).toHaveLength(1)
    expect(errors.map((e) => (e as Error).message)).toContain('disk full')
  })

  it('reports but swallows a throwing onError handler', async () => {
    const { cloudFetch } = cloudSpy()
    const brokenStore = {
      put: () => {
        throw new Error('disk full')
      },
      close: () => {},
    } as unknown as LocalReceiptStore

    const telemetry = makeTelemetry({
      mode: 'cloud',
      apiKey: 'sk_test',
      cloudFetch,
      localStore: brokenStore,
      onError: () => {
        throw new Error('logging is broken')
      },
    })

    await expect(telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')).resolves.toBeInstanceOf(Response)
  })

  it('closes idempotently', () => {
    const telemetry = makeTelemetry()
    telemetry.close()
    expect(() => {
      telemetry.close()
    }).not.toThrow()
  })

  it('flushes a telemetry with no queue', async () => {
    await expect(makeTelemetry({ mode: 'local' }).flush()).resolves.toBeUndefined()
  })

  it('reports errors through onError', () => {
    const errors: unknown[] = []
    const telemetry = makeTelemetry({
      localStore: {
        put: () => {
          throw new Error('nope')
        },
        close: () => {},
      } as unknown as LocalReceiptStore,
      onError: (error) => errors.push(error),
    })

    telemetry.wrap(scraperFetch(), 'https://api.example.com/v1/x')

    return vi.waitFor(() => {
      expect(errors).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// instrumentFetch
// ---------------------------------------------------------------------------

describe('instrumentFetch', () => {
  it('wraps the global fetch and records calls', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', scraperFetch('{"items":[1]}'))

    try {
      const telemetry = makeTelemetry()
      const wrapped = telemetry.instrumentFetch({ provider: 'global-provider', operation: 'global-op' })

      const response = await wrapped('https://api.example.com/v1/x')
      expect(await response.text()).toBe('{"items":[1]}')

      const receipt = (await receiptsOf(telemetry))[0]!
      expect(receipt.provider).toBe('global-provider')
      expect(receipt.operation).toBe('global-op')
    } finally {
      vi.stubGlobal('fetch', original)
    }
  })

  it('rejects rather than throwing when there is no global fetch', async () => {
    vi.stubGlobal('fetch', undefined)
    try {
      const wrapped = makeTelemetry().instrumentFetch()
      await expect(wrapped('https://api.example.com/v1/x')).rejects.toBeInstanceOf(Error)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('randomId', () => {
  it('produces URL-safe ids of the requested length', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomId()
      expect(id).toHaveLength(21)
      expect(id).toMatch(/^[0-9A-Za-z_-]+$/)
    }
  })

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomId()))
    expect(ids.size).toBe(500)
  })
})
