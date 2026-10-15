/**
 * Cross-path canonicalization test.
 *
 * The V1 handoff requires a file that "canonicalizes the same payload in SDK and
 * server code paths and asserts identical byte output", and requires it to pass
 * in CI before any release. It guards the most expensive class of bug in this
 * system: the SDK hashing one thing while the backend signs another, producing
 * receipts that nobody can ever verify.
 *
 * Three independently-written "code paths" are simulated and must agree
 * byte-for-byte:
 *
 *   1. SDK       builds the receipt in the order the SDK's own code happens to
 *                run, and the ingestion event it transmits.
 *   2. Backend   receives the event as JSON text, then rebuilds the receipt in a
 *                DIFFERENT field order - as a separately-authored service using
 *                a different style plausibly would.
 *   3. Verifier  replays the stored receipt using the raw `canonicalize` package
 *                and a hand-rolled removal of the two unsigned fields. This is
 *                exactly what a third party would write with no access to
 *                `@notched/protocol`, so it is the real interop risk.
 *
 * Path 3 is the important one. It proves the protocol package's guard and
 * wrappers do not put any bytes on the wire that an outside implementation
 * cannot reproduce.
 */

import canonicalize from 'canonicalize'
import { describe, expect, it } from 'vitest'

import {
  canonicalizeJson,
  canonicalizeReceiptForSigning,
  hashCanonicalJson,
  hashRawBytes,
  hashReceiptForSigning,
  receiptSigningPayload,
  redactBody,
  redactHeaders,
  type IngestEvent,
  type Receipt,
} from '../packages/protocol/src/index.js'

const utf8Hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex')

// ---------------------------------------------------------------------------
// The raw material of a call
// ---------------------------------------------------------------------------

const RAW_REQUEST_BODY = {
  urls: ['https://example.com/a', 'https://example.com/b'],
  email: 'buyer@example.com',
  api_key: 'sk_live_THIS_MUST_NEVER_BE_STORED',
  options: { render: true, timeoutMs: 30000, locale: 'fr-FR' },
}

/** A response that is `200 OK` but empty - the silent failure the product exists to catch. */
const RAW_RESPONSE_BODY = { items: [], meta: { page: 1e21, unicode: 'A\u030a', currency: '€' } }
const RAW_RESPONSE_BYTES = Buffer.from(JSON.stringify(RAW_RESPONSE_BODY), 'utf8')

// ---------------------------------------------------------------------------
// Path 1: the SDK
// ---------------------------------------------------------------------------

function sdkRequestHash(): string {
  return hashCanonicalJson(redactBody(RAW_REQUEST_BODY))
}

function sdkEvent(): IngestEvent {
  return {
    eventId: 'evt_SDK0000000000000001',
    receiptId: 'rcpt_SDK0000000000000001',
    timestamp: '2026-10-13T09:30:00.000Z',
    latencyMs: 137,
    request: {
      method: 'POST',
      url: 'https://api.scraper-x.example/v1/extract?api_key=sk_live_QUERY_SECRET&q=shoes',
      headers: redactHeaders({
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk_live_HEADER_SECRET',
        'X-Request-Id': 'req_abc',
      }),
      bodyHash: sdkRequestHash(),
      bodyPreview: null,
    },
    response: {
      status: 200,
      headers: redactHeaders({ 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc' }),
      bodyHash: hashRawBytes(RAW_RESPONSE_BYTES),
      bodyPreview: null,
      contentType: 'application/json',
    },
    validation: {
      passed: false,
      rules: ['non-empty', 'min-length:items:1'],
      errors: ['items: expected at least 1, got 0'],
    },
    metadata: {
      provider: 'scraper-x',
      operation: 'extract',
      sdkVersion: '0.1.0',
      environment: 'production',
      registration: 'hash-only',
    },
  }
}

function sdkReceipt(): Receipt {
  return {
    schemaVersion: '1',
    receiptId: 'rcpt_SDK0000000000000001',
    tenantId: 'tnt_8f2b1c4d9e',
    sellerId: null,
    provider: 'scraper-x',
    operation: 'extract',
    requestHash: sdkRequestHash(),
    responseHash: hashRawBytes(RAW_RESPONSE_BYTES),
    statusCode: 200,
    latencyMs: 137,
    timestamp: '2026-10-13T09:30:00.000Z',
    registration: 'hash-only',
    attestation: 'platform',
    validation: {
      passed: false,
      rules: ['non-empty', 'min-length:items:1'],
      errors: ['items: expected at least 1, got 0'],
    },
    anomaly: null,
    buyerOverride: null,
    sdkVersion: '0.1.0',
    // The SDK does not know which key will sign, so the draft carries no key id.
    keyId: null,
    // Unsigned draft: the backend fills these in after signing.
    serverSignature: null,
    signedAt: null,
  }
}

// ---------------------------------------------------------------------------
// Path 2: the backend, rebuilding from the wire in a different field order
// ---------------------------------------------------------------------------

/**
 * The signing key the backend will use. In production this comes from deploy
 * config (`NOTCHED_SIGNING_KEY`); here it is fixed so the bytes are reproducible.
 */
const SIGNING_KEY_ID = 'k_0001'

/**
 * Rebuild the receipt from the ingested event.
 *
 * `signingKeyId` is the key the backend is about to sign with, and is `null` while
 * the receipt is still a draft. It must be supplied here rather than hardcoded
 * because `keyId` sits INSIDE the signed payload: the SDK cannot know it, so the
 * backend stamps it at signing time and only then canonicalizes. This is precisely
 * the step that makes an SDK draft differ from the final signed receipt.
 */
function backendReceiptFromWire(wire: string, signingKeyId: string | null = null): Receipt {
  const event = JSON.parse(wire) as IngestEvent

  // Field order below is deliberately different from `sdkReceipt()`. A
  // canonicalization scheme that leaked insertion order would fail right here.
  return {
    sdkVersion: event.metadata.sdkVersion,
    validation: event.validation,
    operation: event.metadata.operation,
    provider: event.metadata.provider,
    attestation: 'platform',
    registration: event.metadata.registration,
    anomaly: null,
    buyerOverride: null,
    responseHash: event.response.bodyHash,
    requestHash: event.request.bodyHash,
    statusCode: event.response.status,
    latencyMs: 137,
    timestamp: event.timestamp,
    sellerId: null,
    tenantId: 'tnt_8f2b1c4d9e',
    receiptId: event.receiptId,
    schemaVersion: '1',
    keyId: signingKeyId,
    serverSignature: null,
    signedAt: null,
  }
}

// ---------------------------------------------------------------------------
// Path 3: an independent verifier with no knowledge of @notched/protocol
// ---------------------------------------------------------------------------

/**
 * The raw library is typed as returning `string | undefined`. Narrowing it here
 * keeps the "no silent undefined in a hashing path" rule visible: a verifier
 * that hashed `undefined` would produce a plausible-looking but meaningless
 * digest.
 */
const rawCanonicalize = (value: unknown): string => {
  const out = canonicalize(value)
  if (typeof out !== 'string') throw new Error('the raw canonicalizer produced no output')
  return out
}

/**
 * Reconstruct the signed bytes the way a third-party verifier would: parse the
 * stored receipt, drop the two unsigned fields, serialize with the raw library.
 *
 * No use of `@notched/protocol` anywhere in this function - that is the point.
 */
function externalVerifierSigningBytes(storedReceiptJson: string): string {
  const parsed = JSON.parse(storedReceiptJson) as Record<string, unknown>
  const { serverSignature: _s, signedAt: _t, ...unsigned } = parsed
  return rawCanonicalize(unsigned)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-path canonicalization', () => {
  it('produces identical signing bytes across SDK and backend paths', () => {
    const wire = JSON.stringify(sdkEvent())

    // Both sides are compared in the SAME state: the draft, before any signing key
    // is known. This is the drift check - the SDK and the backend must agree on
    // every observation field and on canonicalization. The signing-time completion
    // is a separate, deterministic step, tested next.
    const sdkBytes = canonicalizeReceiptForSigning(sdkReceipt())
    const backendBytes = canonicalizeReceiptForSigning(backendReceiptFromWire(wire))

    expect(backendBytes).toBe(sdkBytes)
    expect(hashReceiptForSigning(backendReceiptFromWire(wire))).toBe(hashReceiptForSigning(sdkReceipt()))
    expect(sdkReceipt().keyId).toBeNull()
  })

  it('stamps the signing key at signing time, which changes the signed bytes', () => {
    // keyId is inside the signed payload but only the signer knows it, so the
    // backend's completion step necessarily changes the signed bytes. An SDK draft
    // is therefore deliberately NOT byte-identical to the signed receipt, and the
    // drift guarantee is narrower than it first appears: SDK and backend must agree
    // on every OBSERVATION field, and this is a deterministic step on top.
    const wire = JSON.stringify(sdkEvent())
    const draft = backendReceiptFromWire(wire)
    const signable = backendReceiptFromWire(wire, SIGNING_KEY_ID)

    expect(draft.keyId).toBeNull()
    expect(signable.keyId).toBe('k_0001')

    const draftBytes = canonicalizeReceiptForSigning(draft)
    const signableBytes = canonicalizeReceiptForSigning(signable)

    expect(signableBytes).not.toBe(draftBytes)
    expect(draftBytes).toContain('"keyId":null')
    expect(signableBytes).toContain('"keyId":"k_0001"')

    // keyId is the ONLY difference the completion step introduces.
    expect(signableBytes.replace('"keyId":"k_0001"', '"keyId":null')).toBe(draftBytes)
  })

  it('produces bytes an independent third-party verifier reproduces exactly', () => {
    // The stored artefact is a SIGNED receipt, so it names the signing key.
    const signed: Receipt = {
      ...backendReceiptFromWire(JSON.stringify(sdkEvent()), SIGNING_KEY_ID),
      serverSignature: 'ed25519:U0VMRi1TSUdOQVRVUkU=',
      signedAt: '2026-10-13T09:30:01.000Z',
    }

    // What the buyer stores, what the CLI reads, what a verifier receives.
    const storedJson = JSON.stringify(signed)

    expect(externalVerifierSigningBytes(storedJson)).toBe(canonicalizeReceiptForSigning(signed))
    expect(utf8Hex(externalVerifierSigningBytes(storedJson))).toBe(utf8Hex(canonicalizeReceiptForSigning(signed)))
  })

  it('exposes the schema version and signing key id to an independent verifier', () => {
    // A verifier must recover both from the signed bytes alone: the version tells
    // it which field set to expect, and the key id tells it which published public
    // key to check against.
    const signed: Receipt = {
      ...backendReceiptFromWire(JSON.stringify(sdkEvent()), SIGNING_KEY_ID),
      serverSignature: 'ed25519:U0VMRi1TSUdOQVRVUkU=',
      signedAt: '2026-10-13T09:30:01.000Z',
    }
    const bytes = externalVerifierSigningBytes(JSON.stringify(signed))
    expect(bytes).toContain('"schemaVersion":"1"')
    expect(bytes).toContain('"keyId":"k_0001"')
  })

  it('survives Unicode, astral characters and exponent-notation numbers identically', () => {
    const hostile = {
      decomposed: 'A\u030a',
      emoji: '\ud83d\ude02',
      euro: '€',
      big: 1e21,
      tiny: 1e-7,
      negativeZero: -0,
      controls: '\u0000\u001f',
    }
    const sdkBytes = canonicalizeJson(hostile)
    const verifierBytes = rawCanonicalize(JSON.parse(JSON.stringify(hostile)) as unknown)
    expect(verifierBytes).toBe(sdkBytes)
    expect(utf8Hex(verifierBytes)).toBe(utf8Hex(sdkBytes))
  })

  it('recomputes the same request and response hashes on both sides', () => {
    const wire = JSON.stringify(sdkEvent())
    const event = JSON.parse(wire) as IngestEvent

    // The backend re-derives the hashes from what it received; they must match
    // what the SDK claimed, or the receipt describes a different call.
    expect(event.request.bodyHash).toBe(hashCanonicalJson(redactBody(RAW_REQUEST_BODY)))
    expect(event.response.bodyHash).toBe(hashRawBytes(RAW_RESPONSE_BYTES))
  })

  it('never transmits a secret in any field it stores', () => {
    const event = sdkEvent()
    const serialised = JSON.stringify(event)

    for (const secret of ['sk_live_THIS_MUST_NEVER_BE_STORED', 'sk_live_HEADER_SECRET', 'session=abc']) {
      expect(serialised).not.toContain(secret)
    }

    // The header secret is gone, the benign header survives.
    expect(event.request.headers['Authorization']).toBe('<redacted>')
    expect(event.request.headers['X-Request-Id']).toBe('req_abc')

    // The redacted body still records that a secret WAS present, without its value.
    expect(canonicalizeJson(redactBody(RAW_REQUEST_BODY))).toContain('<redacted>')
  })

  it('is stable across a full serialise -> parse -> serialise cycle', () => {
    const first = canonicalizeReceiptForSigning(sdkReceipt())
    const roundTripped = JSON.parse(JSON.stringify(sdkReceipt())) as Receipt
    const second = canonicalizeReceiptForSigning(roundTripped)
    const third = canonicalizeReceiptForSigning(JSON.parse(JSON.stringify(roundTripped)) as Receipt)

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('omits exactly the two unsigned fields from the signed bytes', () => {
    const payload = receiptSigningPayload(sdkReceipt()) as Record<string, unknown>
    const bytes = canonicalizeReceiptForSigning(sdkReceipt())
    expect(payload).not.toHaveProperty('serverSignature')
    expect(payload).not.toHaveProperty('signedAt')
    expect(bytes).not.toContain('serverSignature')
    expect(bytes).not.toContain('signedAt')
  })
})
