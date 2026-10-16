/**
 * `fetch` interception tests.
 *
 * The required three are here - same bytes as unwrapped, capture failure
 * swallowed, hashes correct against a fixture - and they are backed by the
 * properties that make the module safe to put in front of a live API call:
 * that it returns the *identical* response object, that it never writes to the
 * caller's `RequestInit`, that it never consumes a stream it cannot rewind, and
 * that capture is deferred until after the caller has their response.
 *
 * The default scheduler is `setImmediate`, so tests either await a capture
 * promise or explicitly flush the deferred queue - never a bare timeout.
 */

import { describe, expect, it, vi } from 'vitest'

import { canonicalizeJson } from '../src/canonical.js'
import { SENTINELS, hashCanonicalJson, hashRawBytes, isHash, isSentinel } from '../src/hash.js'
import { DEFAULT_MAX_RESPONSE_BYTES, instrumentFetch, type CapturedCall, type FetchLike } from '../src/intercept.js'
import { redactBody } from '../src/redact.js'

const RESPONSE_BODY = '{"items":[1,2,3],"meta":{"page":1}}'

/** A request body containing a secret, to prove redaction is inside the hash. */
const REQUEST_BODY = {
  urls: ['https://example.com/a'],
  api_key: 'sk_live_REQUEST_SECRET',
  options: { render: true },
}

const UTF8 = new TextEncoder()

function responseFixture(body = RESPONSE_BODY): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'session=SHOULD_BE_REDACTED' },
  })
}

/** Collect captures, with a promise for the first one so no test needs a timeout. */
function collector(): {
  captures: CapturedCall[]
  onCapture: (capture: CapturedCall) => void
  first: () => Promise<CapturedCall>
} {
  const captures: CapturedCall[] = []
  let resolveFirst: ((capture: CapturedCall) => void) | undefined
  const firstCapture = new Promise<CapturedCall>((resolve) => {
    resolveFirst = resolve
  })

  return {
    captures,
    onCapture: (capture) => {
      captures.push(capture)
      resolveFirst?.(capture)
    },
    first: () => firstCapture,
  }
}

/** Let the deferred capture queue run. */
async function flushDeferred(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

// ---------------------------------------------------------------------------
// Required: same bytes as unwrapped
// ---------------------------------------------------------------------------

describe('pass-through', () => {
  it('returns the same bytes as an unwrapped call', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const wrapped = instrumentFetch({ fetchImpl })

    const plain = await fetchImpl('https://api.example.com/v1/extract')
    const viaWrapper = await wrapped('https://api.example.com/v1/extract')

    expect(await viaWrapper.text()).toBe(await plain.text())
  })

  it('returns the identical Response object the real fetch produced', async () => {
    // Identity, not equality: it is literally the same object, so it cannot have
    // been rebuilt or rewritten on the way through.
    const fixed = responseFixture()
    const fetchImpl: FetchLike = async () => fixed
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    const response = await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(response).toBe(fixed)
    expect(response.status).toBe(200)
    expect(capture.status).toBe(200)
    expect(capture.responseBodyHash).toBe(hashRawBytes(UTF8.encode(RESPONSE_BODY)))
    expect(await response.text()).toBe(RESPONSE_BODY)
  })

  it('leaves the caller able to read the body after capture has read it too', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, registration: 'full' })

    const response = await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    // Both readings succeeded: the tee from `clone()` serves each side.
    expect(capture.responseBodyHash).toBe(hashRawBytes(UTF8.encode(RESPONSE_BODY)))
    expect(await response.text()).toBe(RESPONSE_BODY)
  })

  it('does not mutate the caller\'s RequestInit', async () => {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_live_H' },
      body: JSON.stringify(REQUEST_BODY),
    }
    const snapshot = structuredClone(init)

    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract', init)
    await first()

    expect(init).toEqual(snapshot)
    expect(init.body).toBe(JSON.stringify(REQUEST_BODY))
  })

  it('passes the original input and init through to the real fetch untouched', async () => {
    const init: RequestInit = { method: 'PUT' }
    const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => responseFixture())
    const wrapped = instrumentFetch({ fetchImpl: spy })

    await wrapped('https://api.example.com/v1/extract', init)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/extract')
    expect(spy.mock.calls[0]?.[1]).toBe(init)
  })

  it('propagates the caller\'s own fetch error unchanged', async () => {
    // A network failure belongs to the caller. Swallowing it would turn a real
    // outage into a success.
    const boom = new Error('network down')
    const fetchImpl: FetchLike = async () => {
      throw boom
    }
    const wrapped = instrumentFetch({ fetchImpl, onCapture: () => {} })

    await expect(wrapped('https://api.example.com/v1/extract')).rejects.toBe(boom)
  })

  it('rejects rather than throwing synchronously when no fetch is available', async () => {
    // Exercises the real branch: the global is absent, so there is nothing to wrap.
    vi.stubGlobal('fetch', undefined)
    try {
      const wrapped = instrumentFetch({})
      await expect(wrapped('https://api.example.com/v1/extract')).rejects.toBeInstanceOf(Error)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---------------------------------------------------------------------------
// Required: capture failure is swallowed
// ---------------------------------------------------------------------------

describe('fail-open capture', () => {
  it('swallows a failing clone() and returns the response untouched', async () => {
    const hostile = {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      clone() {
        throw new Error('clone is broken')
      },
      text: async () => RESPONSE_BODY,
    } as unknown as Response

    const fetchImpl: FetchLike = async () => hostile
    const { captures, onCapture } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    const response = await wrapped('https://api.example.com/v1/extract')

    expect(response).toBe(hostile)
    expect(await response.text()).toBe(RESPONSE_BODY)

    await flushDeferred()
    expect(captures).toHaveLength(0)
  })

  it('swallows a failing body read and still returns the response', async () => {
    const brokenClone = {
      arrayBuffer: async () => {
        throw new Error('body read failed')
      },
    }
    const hostile = {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      clone: () => brokenClone,
      text: async () => RESPONSE_BODY,
    } as unknown as Response

    const fetchImpl: FetchLike = async () => hostile
    const { captures, onCapture } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    const response = await wrapped('https://api.example.com/v1/extract')
    expect(await response.text()).toBe(RESPONSE_BODY)

    await flushDeferred()
    expect(captures).toHaveLength(0)
  })

  it('swallows a throwing onCapture', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const wrapped = instrumentFetch({
      fetchImpl,
      onCapture: () => {
        throw new Error('the consumer is broken')
      },
    })

    const response = await wrapped('https://api.example.com/v1/extract')
    expect(await response.text()).toBe(RESPONSE_BODY)

    // Reaching here without an unhandled rejection is the assertion.
    await flushDeferred()
  })

  it('swallows a throwing scheduler', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const wrapped = instrumentFetch({
      fetchImpl,
      onCapture: () => {},
      schedule: () => {
        throw new Error('scheduler is broken')
      },
    })

    const response = await wrapped('https://api.example.com/v1/extract')
    expect(await response.text()).toBe(RESPONSE_BODY)
  })

  it('does no capture work at all when no onCapture is supplied', async () => {
    const fixed = responseFixture()
    const cloneSpy = vi.spyOn(fixed, 'clone')
    const fetchImpl: FetchLike = async () => fixed
    const wrapped = instrumentFetch({ fetchImpl })

    await wrapped('https://api.example.com/v1/extract')

    expect(cloneSpy).not.toHaveBeenCalled()
    expect(await fixed.text()).toBe(RESPONSE_BODY)
  })
})

// ---------------------------------------------------------------------------
// Required: hashes computed correctly against a fixture
// ---------------------------------------------------------------------------

describe('hashes', () => {
  it('computes the request hash over the REDACTED-CANONICAL form', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_live_HEADER' },
      body: JSON.stringify(REQUEST_BODY),
    })

    const capture = await first()

    // Independently recompute what the locked V1 behaviour requires.
    const expected = hashCanonicalJson(redactBody(REQUEST_BODY))
    expect(capture.requestBodyHash).toBe(expected)

    // Redaction really is inside the hash: the secret is replaced, so this differs
    // from hashing the body as the caller supplied it.
    expect(capture.requestBodyHash).not.toBe(hashCanonicalJson(REQUEST_BODY))
    expect(canonicalizeJson(redactBody(REQUEST_BODY))).toContain('<redacted>')
  })

  it('computes the response hash over the raw bytes as received', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.responseBodyHash).toBe(hashRawBytes(UTF8.encode(RESPONSE_BODY)))
    expect(capture.responseBytes).toEqual(UTF8.encode(RESPONSE_BODY))
    expect(capture.status).toBe(200)
    expect(capture.contentType).toBe('application/json')
  })

  it('hashes an absent request body as the JSON value null', async () => {
    // Distinguishable from an empty-string body, which canonicalises to `""`.
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.requestBodyHash).toBe(hashCanonicalJson(null))
    expect(capture.requestBodyHash).not.toBe(hashCanonicalJson(''))
  })

  it('hashes a non-JSON request body as raw bytes, with no preview', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, registration: 'full' })

    await wrapped('https://api.example.com/v1/extract', { method: 'POST', body: 'a=1&b=2' })
    const capture = await first()

    expect(capture.requestBodyHash).toBe(hashRawBytes(UTF8.encode('a=1&b=2')))
    // A raw preview could disclose a credential verbatim, and this body cannot be
    // structurally redacted, so there is no preview even in `full` mode.
    expect(capture.requestBodyPreview).toBeNull()
  })

  it('records a null request hash for a body it cannot read without side effects', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(UTF8.encode('{"a":1}'))
        controller.close()
      },
    })

    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract', { method: 'POST', body: stream } as RequestInit)
    const capture = await first()

    // Reading the stream would have consumed the caller's request body, so this is
    // reported as a sentinel - explicitly "not a hash" - rather than a guess.
    expect(capture.requestBodyHash).toBe(SENTINELS.unsupportedBodyType)
    // A sentinel must never wear a hash prefix, so a format check reaches the same
    // conclusion on every receipt.
    expect(isHash(capture.requestBodyHash)).toBe(false)
    expect(capture.requestBodyHash.startsWith('sha256:')).toBe(false)
    expect(isSentinel(capture.requestBodyHash)).toBe(true)

    // Proof it was left alone: the caller can still read it.
    const reader = stream.getReader()
    const chunk = await reader.read()
    expect(chunk.done).toBe(false)
    reader.releaseLock()
  })

  it('captures a body carried by a Request object, via a non-destructive clone', async () => {
    const request = new Request('https://api.example.com/v1/extract', {
      method: 'POST',
      body: JSON.stringify({ q: 'shoes', token: 'sk_live_IN_REQUEST' }),
    })

    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped(request)
    const capture = await first()

    expect(capture.method).toBe('POST')
    expect(capture.requestBodyHash).toBe(hashCanonicalJson(redactBody({ q: 'shoes', token: 'sk_live_IN_REQUEST' })))
  })
})

// ---------------------------------------------------------------------------
// Redaction of everything captured
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('redacts request and response headers', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract', {
      headers: { authorization: 'Bearer sk_live_HEADER', 'x-request-id': 'req_1' },
    })
    const capture = await first()

    expect(capture.requestHeaders['authorization']).toBe('<redacted>')
    expect(capture.requestHeaders['x-request-id']).toBe('req_1')
    expect(capture.responseHeaders['set-cookie']).toBe('<redacted>')
    expect(capture.responseHeaders['content-type']).toBe('application/json')
  })

  it('redacts credentials and secrets in the captured URL', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    await wrapped('https://api.example.com/v1/extract?api_key=sk_live_QUERY&q=shoes')
    const capture = await first()

    expect(capture.url).not.toContain('sk_live_QUERY')
    expect(capture.url).toContain('q=shoes')
  })

  it('emits previews only in full registration, and redacted', async () => {
    const fetchImpl: FetchLike = async () => responseFixture('{"email":"a@b.com","items":[1]}')

    const hashOnly = collector()
    await instrumentFetch({ fetchImpl, onCapture: hashOnly.onCapture })('https://api.example.com/v1/extract')
    const hashOnlyCapture = await hashOnly.first()
    expect(hashOnlyCapture.responseBodyPreview).toBeNull()
    expect(hashOnlyCapture.requestBodyPreview).toBeNull()

    const full = collector()
    await instrumentFetch({ fetchImpl, onCapture: full.onCapture, registration: 'full' })(
      'https://api.example.com/v1/extract',
      { method: 'POST', body: JSON.stringify(REQUEST_BODY) },
    )
    const fullCapture = await full.first()

    expect(fullCapture.responseBodyPreview).toContain('<redacted>')
    expect(fullCapture.responseBodyPreview).not.toContain('a@b.com')
    expect(fullCapture.requestBodyPreview).toContain('<redacted>')
    expect(fullCapture.requestBodyPreview).not.toContain('sk_live_REQUEST_SECRET')
  })

  it('defaults to hash-only, the privacy-safe mode', async () => {
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()

    instrumentFetch({ fetchImpl, onCapture })('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.responseBodyPreview).toBeNull()
    expect(capture.requestBodyPreview).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Non-blocking and timing
// ---------------------------------------------------------------------------

describe('deferral and timing', () => {
  it('defers capture until after the response is in the caller\'s hands', async () => {
    const order: string[] = []
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()

    const wrapped = instrumentFetch({
      fetchImpl,
      onCapture: (capture) => {
        order.push('capture')
        onCapture(capture)
      },
    })

    await wrapped('https://api.example.com/v1/extract')
    order.push('returned')
    await first()

    expect(order).toEqual(['returned', 'capture'])
  })

  it('records latency and timestamp from the injected clock', async () => {
    const stamps = [1_000, 1_042]
    const fetchImpl: FetchLike = async () => responseFixture()
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, now: () => stamps.shift() ?? 0 })

    await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.latencyMs).toBe(42)
    expect(capture.timestamp).toBe(new Date(1_042).toISOString())
  })

  it('captures a non-2xx response without judging it', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('{"error":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } })
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    const response = await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    // The notary records the status; it does not throw on it.
    expect(response.status).toBe(500)
    expect(capture.status).toBe(500)
  })

  it('captures an empty response body', async () => {
    const fetchImpl: FetchLike = async () => new Response(null, { status: 204 })
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture })

    const response = await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(response.status).toBe(204)
    expect(capture.responseBytes).toHaveLength(0)
    expect(capture.responseBodyHash).toBe(hashRawBytes(new Uint8Array(0)))
  })
})

// ---------------------------------------------------------------------------
// Response size cap (D-015)
// ---------------------------------------------------------------------------

describe('response size cap', () => {
  it('defaults to 1 MB', () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(1_048_576)
  })

  it('hashes a body exactly at the cap', async () => {
    const body = 'x'.repeat(64)
    const fetchImpl: FetchLike = async () => new Response(body)
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, maxResponseBytes: 64 })

    await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    // At the cap, not over it: a real hash.
    expect(isHash(capture.responseBodyHash)).toBe(true)
    expect(capture.responseBodyHash).toBe(hashRawBytes(UTF8.encode(body)))
    expect(capture.responseBytes).toEqual(UTF8.encode(body))
  })

  it('emits sentinel:oversize one byte over the cap and retains nothing', async () => {
    const fetchImpl: FetchLike = async () => new Response('x'.repeat(65))
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, maxResponseBytes: 64 })

    await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.responseBodyHash).toBe(SENTINELS.oversize)
    // Never a hash prefix on a non-hash.
    expect(isHash(capture.responseBodyHash)).toBe(false)
    expect(isSentinel(capture.responseBodyHash)).toBe(true)
    // `null` means "not retained", which is distinguishable from an empty body.
    expect(capture.responseBytes).toBeNull()
    expect(capture.responseBodyPreview).toBeNull()
  })

  it('leaves the caller\'s body fully readable after abandoning an oversized read', async () => {
    // The critical safety property. Stopping early cancels the tee branch we were
    // reading; per the streams spec that must not affect the caller's branch. If
    // this ever fails, the cap is unsafe and must be implemented differently.
    const body = 'x'.repeat(5000)
    const fetchImpl: FetchLike = async () => new Response(body)
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, maxResponseBytes: 100 })

    const response = await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.responseBodyHash).toBe(SENTINELS.oversize)
    expect(await response.text()).toBe(body)
  })

  it('stops pulling from the source once the cap is exceeded', async () => {
    // Proves the cap actually caps memory rather than reading everything and
    // rejecting afterwards.
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 100) {
          controller.close()
          return
        }
        controller.enqueue(UTF8.encode('x'.repeat(1000)))
      },
    })

    const fetchImpl: FetchLike = async () => new Response(stream)
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, maxResponseBytes: 100 })

    const response = await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.responseBodyHash).toBe(SENTINELS.oversize)
    // One 1000-byte chunk is enough to exceed a 100-byte cap.
    expect(pulled).toBeLessThan(5)

    // Drain the caller's copy so no stream is left pending.
    await response.arrayBuffer()
  })

  it('does not apply the cap to a small body', async () => {
    const fetchImpl: FetchLike = async () => new Response(RESPONSE_BODY)
    const { onCapture, first } = collector()
    const wrapped = instrumentFetch({ fetchImpl, onCapture, maxResponseBytes: 1_048_576 })

    await wrapped('https://api.example.com/v1/extract')
    const capture = await first()

    expect(capture.responseBodyHash).toBe(hashRawBytes(UTF8.encode(RESPONSE_BODY)))
  })
})
