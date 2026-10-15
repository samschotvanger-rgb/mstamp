/**
 * Test signing keys and events.
 *
 * The fixture key lives here rather than in `src/` on purpose: a hard-coded seed in
 * shipped code is a known private key, and the failure mode - someone deploying with the
 * test key because it happened to work locally - is catastrophic and silent. Tests
 * inject this key explicitly, which also means nothing in `src/` needs a "test mode".
 *
 * It is still deterministic, so signatures and receipts are reproducible.
 */

import type { IngestEvent } from '@notched/protocol'

import { parseSigningSeed, signingKeyFromSeed, type SigningKey } from '../../src/crypto/sign.js'

/** 32 bytes of 0x01. Never use this outside tests. */
export const TEST_SEED = new Uint8Array(32).fill(1)

export const TEST_SEED_BASE64 = Buffer.from(TEST_SEED).toString('base64')

export const TEST_KEY_ID = 'k_test_0001'

/** A second, unrelated key, for "wrong key" assertions. */
export const OTHER_SEED = new Uint8Array(32).fill(2)

/** 32 bytes of 0x03. The payload encryption master key. Never use this outside tests. */
export const TEST_MASTER_KEY = new Uint8Array(32).fill(3)

export const TEST_MASTER_KEY_BASE64 = Buffer.from(TEST_MASTER_KEY).toString('base64')

/** A different master key, for "wrong master key" assertions. */
export const OTHER_MASTER_KEY = new Uint8Array(32).fill(4)

export async function testSigningKey(keyId: string = TEST_KEY_ID): Promise<SigningKey> {
  return signingKeyFromSeed(parseSigningSeed(TEST_SEED_BASE64), keyId)
}

export async function otherSigningKey(): Promise<SigningKey> {
  return signingKeyFromSeed(OTHER_SEED, 'k_test_other')
}

/** A deterministic clock, so `signedAt` is stable across runs. */
export function fixedClock(iso = '2026-10-15T12:00:00.000Z'): () => number {
  const ms = Date.parse(iso)
  return () => ms
}

/** A valid `IngestEvent`, with every field overridable. */
export function makeIngestEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    eventId: 'evt_0000000000000000001',
    receiptId: 'rcpt_0000000000000000001',
    timestamp: '2026-10-15T11:59:59.000Z',
    latencyMs: 137,
    request: {
      method: 'POST',
      url: 'https://api.scraper-x.example/v1/extract?q=shoes',
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
    validation: {
      passed: false,
      rules: ['min-length:items:1'],
      errors: ['items: expected at least 1, got 0'],
    },
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
