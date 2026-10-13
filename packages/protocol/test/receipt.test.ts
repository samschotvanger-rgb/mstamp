/**
 * Receipt signing-payload tests.
 *
 * This is the single most consequential function in the protocol. The backend
 * signs its output and an offline verifier - running on a third party's machine,
 * possibly years later, with only the receipt JSON and a public key -
 * reconstructs the same payload and checks the signature. If these two
 * computations ever disagree, every receipt silently becomes unverifiable.
 *
 * Hence the tests are mostly about *stability*: byte-identical output under
 * field reordering and JSON round-tripping, and precise sensitivity about which
 * fields do and do not affect the signature.
 */

import { describe, expect, it } from 'vitest'

import { canonicalizeJson } from '../src/canonical.js'
import {
  canonicalizeReceiptForSigning,
  hashReceiptForSigning,
  isSignedReceipt,
  receiptSigningPayload,
} from '../src/receipt.js'
import type { Receipt } from '../src/types.js'

export function sampleReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schemaVersion: '1',
    receiptId: 'rcpt_V1StGXR8Z5jdHi6B',
    tenantId: 'tnt_8f2b1c4d9e',
    sellerId: null,
    provider: 'scraper-x',
    operation: 'extract',
    requestHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    responseHash: 'sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
    statusCode: 200,
    latencyMs: 412,
    timestamp: '2026-10-13T09:30:00.000Z',
    registration: 'hash-only',
    attestation: 'platform',
    validation: { passed: false, rules: ['min-length:items:1'], errors: ['items: expected at least 1, got 0'] },
    anomaly: null,
    buyerOverride: null,
    sdkVersion: '0.1.0',
    keyId: 'k_0001',
    serverSignature: 'ed25519:U0VMRi1TSUdOQVRVUkU=',
    signedAt: '2026-10-13T09:30:01.000Z',
    ...overrides,
  }
}

describe('receiptSigningPayload', () => {
  it('omits exactly serverSignature and signedAt', () => {
    const payload = receiptSigningPayload(sampleReceipt()) as Record<string, unknown>
    expect(payload).not.toHaveProperty('serverSignature')
    expect(payload).not.toHaveProperty('signedAt')

    // Everything else must be present. A dropped field here changes the signed
    // bytes, so this assertion is the guard against silent drift.
    const expected = Object.keys(sampleReceipt()).filter((k) => k !== 'serverSignature' && k !== 'signedAt')
    expect(Object.keys(payload).sort()).toEqual([...expected].sort())
  })

  it('keeps the reserved V2 fields, which must be signed as null in V1', () => {
    const payload = receiptSigningPayload(sampleReceipt()) as Record<string, unknown>
    expect(payload['anomaly']).toBeNull()
    expect(payload['buyerOverride']).toBeNull()
  })

  it('signs the schema version and the signing key id', () => {
    // Both must be inside the signed payload. A version a forger could rewrite
    // would let them reinterpret the field set; a key id a forger could rewrite
    // would let them choose which published key their forgery is checked against.
    const payload = receiptSigningPayload(sampleReceipt()) as Record<string, unknown>
    expect(payload['schemaVersion']).toBe('1')
    expect(payload['keyId']).toBe('k_0001')

    const bytes = canonicalizeReceiptForSigning(sampleReceipt())
    expect(bytes).toContain('"schemaVersion":"1"')
    expect(bytes).toContain('"keyId":"k_0001"')
  })

  it('changes the signed bytes if either new field is tampered with', () => {
    const base = { ...receiptSigningPayload(sampleReceipt()) } as Record<string, unknown>
    expect(canonicalizeJson({ ...base, schemaVersion: '2' })).not.toBe(canonicalizeJson(base))
    expect(canonicalizeJson({ ...base, keyId: 'k_9999' })).not.toBe(canonicalizeJson(base))
    // `null` (no signing key) is a distinct signed value, not an absent field: JSON
    // has no way to omit a key from the payload, and a verifier must be able to tell
    // "unsigned" apart from "signed by k_0001".
    expect(canonicalizeJson({ ...base, keyId: null })).not.toBe(canonicalizeJson(base))
    expect(canonicalizeJson({ ...base, keyId: null })).toContain('"keyId":null')
  })

  it('does not mutate the receipt it was given', () => {
    const receipt = sampleReceipt()
    const snapshot = structuredClone(receipt)
    receiptSigningPayload(receipt)
    expect(receipt).toEqual(snapshot)
  })
})

describe('canonicalizeReceiptForSigning', () => {
  it('is independent of property insertion order', () => {
    // The SDK and the backend build this object in different orders. If the
    // canonical form depended on insertion order, the signature would not verify.
    const a = sampleReceipt()
    const b = sampleReceipt()
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as Receipt

    expect(canonicalizeReceiptForSigning(a)).toBe(canonicalizeReceiptForSigning(reordered))
  })

  it('survives a JSON wire round-trip unchanged', () => {
    const receipt = sampleReceipt()
    const overWire = JSON.parse(JSON.stringify(receipt)) as Receipt
    expect(canonicalizeReceiptForSigning(overWire)).toBe(canonicalizeReceiptForSigning(receipt))
  })

  it('is not affected by the signature or the signing timestamp', () => {
    // Both fields are added AFTER signing, so they must not feed back into the
    // signed bytes - otherwise adding the signature would invalidate it.
    const base = canonicalizeReceiptForSigning(sampleReceipt({ serverSignature: null, signedAt: null }))
    const signed = canonicalizeReceiptForSigning(sampleReceipt({ serverSignature: 'ed25519:AAAA', signedAt: '2026-10-13T09:30:01.000Z' }))
    expect(signed).toBe(base)
  })

  it('ignores the two unsigned fields whatever their value', () => {
    // Amended schema: unsigned receipts carry `null` rather than empty strings.
    // Since both fields are excluded from the payload, null, empty string and a
    // real signature must all produce identical signed bytes.
    const target = canonicalizeReceiptForSigning(sampleReceipt())
    expect(canonicalizeReceiptForSigning(sampleReceipt({ serverSignature: null, signedAt: null }))).toBe(target)
    expect(canonicalizeReceiptForSigning(sampleReceipt({ serverSignature: '', signedAt: '' }))).toBe(target)
    expect(canonicalizeReceiptForSigning(sampleReceipt({ serverSignature: 'ed25519:ZZZ', signedAt: '2030-01-01T00:00:00.000Z' }))).toBe(target)
    expect(hashReceiptForSigning(sampleReceipt({ serverSignature: null, signedAt: null }))).toBe(hashReceiptForSigning(sampleReceipt()))
  })

  it('changes when any signed field changes', () => {
    const base = hashReceiptForSigning(sampleReceipt())
    const mutations: Partial<Receipt>[] = [
      { receiptId: 'rcpt_OTHER' },
      { tenantId: 'tnt_OTHER' },
      { sellerId: 'slr_FIRST' },
      { provider: 'scraper-y' },
      { operation: 'fetch' },
      { requestHash: `sha256:${'0'.repeat(64)}` },
      { responseHash: `sha256:${'1'.repeat(64)}` },
      { statusCode: 500 },
      { latencyMs: 413 },
      { timestamp: '2026-10-13T09:30:00.001Z' },
      { registration: 'full' },
      { attestation: 'self' },
      { sdkVersion: '0.1.1' },
      { keyId: 'k_0002' },
      { validation: { passed: true, rules: [], errors: [] } },
    ]

    for (const mutation of mutations) {
      const field = Object.keys(mutation)[0]!
      expect(hashReceiptForSigning(sampleReceipt(mutation)), `field ${field} must affect the signature`).not.toBe(base)
    }
  })

  it('produces a hash in the standard tagged format', () => {
    expect(hashReceiptForSigning(sampleReceipt())).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('produces a stable, pinned digest for the canonical sample receipt', () => {
    // A tripwire. If this value ever changes, the signed bytes changed, which
    // means every previously-issued receipt just became unverifiable. Changing
    // it is a deliberate protocol-version decision, never a side effect.
    //
    // Baseline: schemaVersion "1", with `schemaVersion` and `keyId` present in the
    // signed field set. It moved from sha256:d42c30d9...f155b when those two
    // fields landed - an expected consequence of changing the signed field set,
    // and the reason the receipt carries a schemaVersion at all.
    //
    // UNCHANGED by the later `keyId: string | null` widening: that is a type-level
    // change and this fixture's key is still "k_0001", so no runtime byte moved. A
    // digest re-baseline was therefore not needed - the byte difference between
    // `null` and "k_0001" is asserted in the tamper test above instead.
    expect(hashReceiptForSigning(sampleReceipt())).toBe('sha256:5c5390bb0a90ad90d7e5a9226edc398d3a2cdc84df2e28b8885ee1a5c04070c7')
  })
})

describe('isSignedReceipt', () => {
  it('is false for locally-written receipts', () => {
    // A local receipt has no signing key at all, so keyId is null rather than a
    // fabricated id - the same rule as serverSignature and signedAt.
    const local = sampleReceipt({
      attestation: 'self',
      registration: 'local',
      serverSignature: null,
      signedAt: null,
      keyId: null,
    })
    expect(local.keyId).toBeNull()
    expect(isSignedReceipt(local)).toBe(false)
  })

  it('is true for backend-signed receipts', () => {
    expect(isSignedReceipt(sampleReceipt())).toBe(true)
  })

  it('is false when the attestation claims a signature that is absent', () => {
    expect(isSignedReceipt(sampleReceipt({ serverSignature: null }))).toBe(false)
  })

  it('is false when the signature exists but the signing time does not', () => {
    // A signature with no timestamp is not a usable attestation, so a half-filled
    // pair must not read as signed.
    expect(isSignedReceipt(sampleReceipt({ signedAt: null }))).toBe(false)
  })
})
