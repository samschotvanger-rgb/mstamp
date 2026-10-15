/**
 * Ed25519 signing and verification.
 *
 * The signature is the product. If it is wrong, every receipt is worthless, so these
 * tests cover the whole surface: the happy path, tampering with the signature, tampering
 * with the content it covers, the wrong key, and every malformed input a hostile client
 * could send to a verification endpoint.
 *
 * Requirement 7 - that `serverSignature` and `signedAt` are excluded from the signed
 * payload - is checked here at the byte level, because it is the property that makes it
 * possible to add a signature to a receipt without invalidating it.
 */

import { canonicalizeReceiptForSigning, type Receipt } from '@notched/protocol'
import * as ed from '@noble/ed25519'
import { describe, expect, it } from 'vitest'

import {
  SIGNATURE_PREFIX,
  decodeSignature,
  parseSigningSeed,
  publicKeyBase64,
  signReceipt,
  signingKeyFromSeed,
  verifyReceipt,
} from '../src/crypto/sign.js'
import { OTHER_SEED, TEST_KEY_ID, TEST_SEED_BASE64, fixedClock, otherSigningKey, testSigningKey } from './helpers/keys.js'

/** An unsigned receipt draft. */
function draft(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schemaVersion: '1',
    receiptId: 'rcpt_0000000000000000001',
    tenantId: 'tnt_a',
    sellerId: null,
    provider: 'scraper-x',
    operation: 'extract',
    requestHash: `sha256:${'a'.repeat(64)}`,
    responseHash: `sha256:${'b'.repeat(64)}`,
    statusCode: 200,
    latencyMs: 137,
    timestamp: '2026-10-15T11:59:59.000Z',
    registration: 'hash-only',
    attestation: 'platform',
    validation: { passed: false, rules: ['min-length:items:1'], errors: ['items: expected at least 1, got 0'] },
    anomaly: null,
    buyerOverride: null,
    sdkVersion: '0.1.0',
    keyId: TEST_KEY_ID,
    serverSignature: null,
    signedAt: null,
    ...overrides,
  }
}

async function signedDraft(overrides: Partial<Receipt> = {}): Promise<Receipt> {
  const key = await testSigningKey()
  const base = draft(overrides)
  return { ...base, ...(await signReceipt(base, key, { now: fixedClock() })) }
}

describe('key handling', () => {
  it('parses a 32-byte seed and derives a 32-byte public key', async () => {
    const key = await testSigningKey()

    expect(key.seed).toHaveLength(32)
    expect(key.publicKey).toHaveLength(32)
    expect(key.keyId).toBe(TEST_KEY_ID)
  })

  it('is deterministic', async () => {
    const first = await testSigningKey()
    const second = await testSigningKey()

    expect(publicKeyBase64(first)).toBe(publicKeyBase64(second))
  })

  it('rejects a seed of the wrong length', async () => {
    await expect(signingKeyFromSeed(new Uint8Array(16), 'k_x')).rejects.toThrow(/32 bytes/)
  })

  it('rejects an empty key id', async () => {
    await expect(signingKeyFromSeed(new Uint8Array(32), '')).rejects.toThrow(/must not be empty/)
  })

  it('rejects a seed that is not base64', () => {
    expect(() => parseSigningSeed('not-base64!!!')).toThrow(/not valid base64/)
  })

  it('does not accept a buffer that merely looks like base64', () => {
    // `Buffer.from(x, 'base64')` silently ignores junk, so a lenient decoder would turn a
    // typo into a wrong key rather than an error.
    expect(() => parseSigningSeed('!!!!')).toThrow()
    expect(() => parseSigningSeed('')).toThrow()
  })
})

describe('signReceipt', () => {
  it('produces an ed25519-prefixed base64 signature of 64 bytes', async () => {
    const key = await testSigningKey()
    const { serverSignature } = await signReceipt(draft(), key)

    expect(serverSignature.startsWith(SIGNATURE_PREFIX)).toBe(true)

    const bytes = decodeSignature(serverSignature)
    expect(bytes).not.toBeNull()
    expect(bytes).toHaveLength(64)
  })

  it('takes signedAt from the injected clock', async () => {
    const key = await testSigningKey()
    const result = await signReceipt(draft(), key, { now: fixedClock('2026-10-15T12:00:00.000Z') })

    expect(result.signedAt).toBe('2026-10-15T12:00:00.000Z')
  })
})

describe('verifyReceipt', () => {
  it('verifies a receipt signed by the matching key', async () => {
    const key = await testSigningKey()
    const receipt = await signedDraft()
    receipt.keyId = key.keyId

    expect(await verifyReceipt(receipt, publicKeyBase64(key))).toBe(true)
  })

  it('rejects a receipt with one byte of the signature tampered', async () => {
    const key = await testSigningKey()
    const receipt = await signedDraft()

    const bytes = decodeSignature(receipt.serverSignature!)!
    const tampered = Uint8Array.from(bytes)
    tampered[0] = (tampered[0] ?? 0) ^ 0x01

    const broken: Receipt = {
      ...receipt,
      serverSignature: `${SIGNATURE_PREFIX}${Buffer.from(tampered).toString('base64')}`,
    }

    expect(await verifyReceipt(broken, publicKeyBase64(key))).toBe(false)
  })

  it('rejects a receipt with one signed field altered', async () => {
    const key = await testSigningKey()
    const receipt = await signedDraft()
    const publicKey = publicKeyBase64(key)

    const alterations: Partial<Receipt>[] = [
      { statusCode: 500 },
      { latencyMs: 138 },
      { responseHash: `sha256:${'c'.repeat(64)}` },
      { requestHash: `sha256:${'d'.repeat(64)}` },
      { provider: 'other-provider' },
      { timestamp: '2026-10-15T11:59:58.000Z' },
      { tenantId: 'tnt_b' },
      { keyId: 'k_other' },
      { validation: { passed: true, rules: [], errors: [] } },
    ]

    for (const alteration of alterations) {
      const field = Object.keys(alteration)[0]!
      expect(await verifyReceipt({ ...receipt, ...alteration }, publicKey), `field ${field}`).toBe(false)
    }
  })

  it('rejects a receipt verified with the wrong public key', async () => {
    const key = await testSigningKey()
    const other = await otherSigningKey()
    const receipt = await signedDraft()

    expect(await verifyReceipt(receipt, publicKeyBase64(key))).toBe(true)
    expect(await verifyReceipt(receipt, publicKeyBase64(other))).toBe(false)
  })

  it('rejects a good signature over a different payload', async () => {
    // Same key, same shape, different content: the signature must not carry over.
    const key = await testSigningKey()
    const first = await signedDraft({ receiptId: 'rcpt_first' })
    const second = draft({ receiptId: 'rcpt_second' })

    const frankenstein: Receipt = { ...second, serverSignature: first.serverSignature, signedAt: first.signedAt }

    expect(await verifyReceipt(frankenstein, publicKeyBase64(key))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Hostile input must not throw
  // -------------------------------------------------------------------------

  it('returns false rather than throwing for a malformed signature', async () => {
    // `@noble/ed25519` THROWS on a wrong-length signature instead of returning false. A
    // verifier that crashes on a corrupt receipt is a denial-of-service surface.
    const key = await testSigningKey()
    const receipt = await signedDraft()
    const publicKey = publicKeyBase64(key)

    const malformed: (string | null)[] = [
      null,
      '',
      'not-a-signature',
      'ed25519:',
      'ed25519:!!!!',
      // 63 bytes: one short.
      `${SIGNATURE_PREFIX}${Buffer.from(new Uint8Array(63)).toString('base64')}`,
      // 65 bytes: one long.
      `${SIGNATURE_PREFIX}${Buffer.from(new Uint8Array(65)).toString('base64')}`,
      // Right shape, wrong prefix.
      `rsa:${Buffer.from(new Uint8Array(64)).toString('base64')}`,
      receipt.serverSignature!.slice(0, 20),
    ]

    for (const serverSignature of malformed) {
      const candidate: Receipt = { ...receipt, serverSignature }
      await expect(verifyReceipt(candidate, publicKey), `sig ${JSON.stringify(serverSignature)}`).resolves.toBe(false)
    }
  })

  it('returns false for a malformed public key', async () => {
    const receipt = await signedDraft()
    const key = await testSigningKey()

    for (const publicKey of ['', 'not-base64!!!', Buffer.from(new Uint8Array(16)).toString('base64')]) {
      await expect(verifyReceipt(receipt, publicKey), `key ${publicKey}`).resolves.toBe(false)
    }

    // A valid base64 32-byte key that is simply not the right one.
    expect(await verifyReceipt(receipt, publicKeyBase64(await otherSigningKey()))).toBe(false)
    expect(OTHER_SEED).toHaveLength(32)
    expect(key.publicKey).toHaveLength(32)
  })

  it('returns false when the payload cannot be canonicalised', async () => {
    const key = await testSigningKey()
    const receipt = await signedDraft()
    // JSON cannot represent `undefined`, and the protocol refuses to rewrite it away.
    const broken = { ...receipt, provider: undefined } as unknown as Receipt

    await expect(verifyReceipt(broken, publicKeyBase64(key))).resolves.toBe(false)
  })
})

describe('the signing payload excludes serverSignature and signedAt', () => {
  it('produces identical bytes whether they are null or populated', async () => {
    const base = draft()

    const asNull = canonicalizeReceiptForSigning({ ...base, serverSignature: null, signedAt: null })
    const asPopulated = canonicalizeReceiptForSigning({
      ...base,
      serverSignature: 'ed25519:anything-at-all',
      signedAt: '2020-01-01T00:00:00.000Z',
    })

    expect(asPopulated).toBe(asNull)

    // Omitted entirely, not present as null.
    expect(asNull).not.toContain('serverSignature')
    expect(asNull).not.toContain('signedAt')
    expect(asNull).not.toContain('null,"signedAt"')
  })

  it('therefore produces an identical signature', async () => {
    const key = await testSigningKey()
    const base = draft()

    const withNulls = await signReceipt({ ...base, serverSignature: null, signedAt: null }, key)
    const withValues = await signReceipt(
      { ...base, serverSignature: 'ed25519:something-else', signedAt: '1999-12-31T23:59:59.000Z' },
      key,
    )

    // Ed25519 is deterministic, so identical payloads give identical signatures - which
    // is only true if the excluded fields really are excluded.
    expect(withValues.serverSignature).toBe(withNulls.serverSignature)
  })

  it('verifies a receipt whose signature was added after the payload was fixed', async () => {
    // The practical consequence: signing does not invalidate itself.
    const key = await testSigningKey()
    const base = draft()
    const signed = { ...base, ...(await signReceipt(base, key)) }

    expect(signed.serverSignature!.startsWith(SIGNATURE_PREFIX)).toBe(true)
    expect(await verifyReceipt(signed, publicKeyBase64(key))).toBe(true)
  })
})

describe('independent verification', () => {
  it('verifies using only the protocol helper, the public key and noble', async () => {
    // This is exactly what the offline verifier and the CLI will do: nothing from the
    // backend's internals, just the receipt JSON, the published key, and the shared
    // canonicalization helper.
    const key = await testSigningKey()
    const receipt = await signedDraft()

    const payload = new TextEncoder().encode(canonicalizeReceiptForSigning(receipt))
    const signature = Buffer.from(receipt.serverSignature!.slice(SIGNATURE_PREFIX.length), 'base64')
    const publicKey = Buffer.from(publicKeyBase64(key), 'base64')

    expect(await ed.verifyAsync(signature, payload, publicKey)).toBe(true)

    // And the same recipe rejects a tampered receipt.
    const tamperedPayload = new TextEncoder().encode(canonicalizeReceiptForSigning({ ...receipt, latencyMs: 1 }))
    expect(await ed.verifyAsync(signature, tamperedPayload, publicKey)).toBe(false)
  })

  it('is independent of the seed used to produce the key', async () => {
    const fromFixture = await testSigningKey()
    const fromBase64 = await signingKeyFromSeed(parseSigningSeed(TEST_SEED_BASE64), TEST_KEY_ID)

    expect(publicKeyBase64(fromBase64)).toBe(publicKeyBase64(fromFixture))
  })
})
