/**
 * Payload preview encryption.
 *
 * Two layers are tested separately, because they fail differently:
 *
 *   - **The crypto** must fail loudly when a key is wrong. AES-GCM's auth tag is what
 *     makes "the wrong tenant asked" a `DecryptionError` rather than plausible garbage,
 *     so the tests assert that a cross-tenant decrypt throws rather than merely disagreeing.
 *   - **The storage** must fail closed through row-level security. Even if the crypto were
 *     broken, tenant A should not be able to reach tenant B's row at all.
 *
 * Testing only one of them would leave the other as the sole line of defence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ENVELOPE_HEADER_BYTES,
  ENCRYPTION_VERSION,
  MASTER_KEY_BYTES,
  DecryptionError,
  MasterKeyError,
  decryptForTenant,
  deriveTenantKey,
  encryptForTenant,
  parseMasterKey,
} from '../src/crypto/encrypt.js'
import { withTenant } from '../src/db/client.js'
import { insertEncryptedPayload } from '../src/db/payloads.js'
import {
  PreviewDecodeError,
  decryptPreviews,
  encryptPreviews,
  hasPreviews,
  loadPreviews,
  storePreviews,
} from '../src/previews.js'
import { createTestDb, seedReceipt, seedTenant, type TestDb } from './helpers/pg.js'
import { OTHER_MASTER_KEY, TEST_MASTER_KEY, TEST_MASTER_KEY_BASE64 } from './helpers/keys.js'

const UTF8 = new TextEncoder()
const PLAINTEXT = UTF8.encode('{"request":{"email":"<redacted>"},"response":null}')

describe('AES-256-GCM primitives', () => {
  it('round-trips plaintext', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)

    expect(decryptForTenant(TEST_MASTER_KEY, 'tnt_a', envelope)).toEqual(PLAINTEXT)
  })

  it('produces a different ciphertext each time, from a fresh IV', () => {
    // A repeated IV under the same key breaks GCM catastrophically, so this is not a
    // stylistic preference.
    const first = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)
    const second = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
    expect(decryptForTenant(TEST_MASTER_KEY, 'tnt_a', second)).toEqual(PLAINTEXT)
  })

  it('lays out a versioned envelope', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)

    expect(envelope[0]).toBe(ENCRYPTION_VERSION)
    expect(envelope).toHaveLength(ENVELOPE_HEADER_BYTES + PLAINTEXT.length)
  })

  it('derives a different key per tenant, deterministically', () => {
    const a = deriveTenantKey(TEST_MASTER_KEY, 'tnt_a')
    const b = deriveTenantKey(TEST_MASTER_KEY, 'tnt_b')

    expect(a).toHaveLength(MASTER_KEY_BYTES)
    expect(a.equals(b)).toBe(false)
    expect(deriveTenantKey(TEST_MASTER_KEY, 'tnt_a').equals(a)).toBe(true)
  })

  it('refuses to derive a key without a tenant', () => {
    expect(() => deriveTenantKey(TEST_MASTER_KEY, '')).toThrow(MasterKeyError)
  })

  // -------------------------------------------------------------------------
  // Required: cross-tenant isolation
  // -------------------------------------------------------------------------

  it('cannot decrypt another tenant\'s ciphertext', () => {
    // This is the property that makes a misrouted read a failure rather than a data leak.
    const forB = encryptForTenant(TEST_MASTER_KEY, 'tnt_b', PLAINTEXT)

    expect(() => decryptForTenant(TEST_MASTER_KEY, 'tnt_a', forB)).toThrow(DecryptionError)

    // And the error does not hint at why.
    try {
      decryptForTenant(TEST_MASTER_KEY, 'tnt_a', forB)
    } catch (error) {
      expect((error as Error).message).not.toContain('tnt_b')
    }
  })

  it('cannot decrypt with the wrong master key', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)

    expect(() => decryptForTenant(OTHER_MASTER_KEY, 'tnt_a', envelope)).toThrow(DecryptionError)
  })

  it('detects tampering with the ciphertext', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)

    for (const index of [0, ENVELOPE_HEADER_BYTES, envelope.length - 1]) {
      const tampered = Uint8Array.from(envelope)
      tampered[index] = (tampered[index] ?? 0) ^ 0x01

      // Index 0 is the version byte, so it fails on the version check instead.
      expect(() => decryptForTenant(TEST_MASTER_KEY, 'tnt_a', tampered), `index ${index}`).toThrow(DecryptionError)
    }
  })

  it('rejects a truncated or empty envelope', () => {
    for (const envelope of [new Uint8Array(0), new Uint8Array(5), new Uint8Array(ENVELOPE_HEADER_BYTES - 1)]) {
      expect(() => decryptForTenant(TEST_MASTER_KEY, 'tnt_a', envelope)).toThrow(DecryptionError)
    }
  })

  it('rejects an unknown envelope version', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', PLAINTEXT)
    envelope[0] = 99

    expect(() => decryptForTenant(TEST_MASTER_KEY, 'tnt_a', envelope)).toThrow(/unsupported ciphertext version/)
  })

  it('round-trips an empty plaintext', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', new Uint8Array(0))

    expect(decryptForTenant(TEST_MASTER_KEY, 'tnt_a', envelope)).toHaveLength(0)
  })
})

describe('parseMasterKey', () => {
  it('accepts 32 bytes of base64', () => {
    expect(parseMasterKey(TEST_MASTER_KEY_BASE64)).toHaveLength(32)
  })

  it('accepts base64url', () => {
    const urlSafe = TEST_MASTER_KEY_BASE64.replace(/\+/g, '-').replace(/\//g, '_')

    expect(Array.from(parseMasterKey(urlSafe))).toEqual(Array.from(TEST_MASTER_KEY))
  })

  it('rejects anything that is not a 32-byte base64 value', () => {
    const malformed = [
      '',
      '   ',
      'not-base64!!!',
      Buffer.from(new Uint8Array(16).fill(1)).toString('base64'),
      Buffer.from(new Uint8Array(64).fill(1)).toString('base64'),
      TEST_MASTER_KEY_BASE64.slice(0, 20),
    ]

    for (const value of malformed) {
      expect(() => parseMasterKey(value), JSON.stringify(value)).toThrow(MasterKeyError)
    }
  })
})

describe('preview envelopes', () => {
  it('recognises when there is nothing to store', () => {
    expect(hasPreviews({ request: null, response: null })).toBe(false)
    expect(hasPreviews({ request: 'x', response: null })).toBe(true)
    expect(hasPreviews({ request: null, response: 'y' })).toBe(true)
  })

  it('round-trips a preview pair', () => {
    const previews = { request: '{"a":1}', response: '{"items":[]}' }
    const envelope = encryptPreviews(TEST_MASTER_KEY, 'tnt_a', previews)

    expect(decryptPreviews(TEST_MASTER_KEY, 'tnt_a', envelope)).toEqual(previews)
  })

  it('rejects a decrypted payload that is not a preview pair', () => {
    // The row exists and decrypts, but is corrupt. That is a different failure from
    // "not yours", and is worth distinguishing.
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', UTF8.encode('{"something":"else"}'))

    expect(() => decryptPreviews(TEST_MASTER_KEY, 'tnt_a', envelope)).toThrow(PreviewDecodeError)
  })

  it('rejects a decrypted payload that is not JSON at all', () => {
    const envelope = encryptForTenant(TEST_MASTER_KEY, 'tnt_a', new Uint8Array([0xff, 0xfe, 0xfd]))

    expect(() => decryptPreviews(TEST_MASTER_KEY, 'tnt_a', envelope)).toThrow(PreviewDecodeError)
  })
})

describe('preview storage', () => {
  let db: TestDb
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    await seedTenant(db, { id: 'tnt_a', apiKey: 'sk_a', name: 'Tenant A' })
    await seedTenant(db, { id: 'tnt_b', apiKey: 'sk_b', name: 'Tenant B' })
    await seedReceipt(db, { id: 'rcpt_a', tenantId: 'tnt_a' })
    await seedReceipt(db, { id: 'rcpt_b', tenantId: 'tnt_b' })
    await seedReceipt(db, { id: 'rcpt_hash_only', tenantId: 'tnt_a' })
    await seedReceipt(db, { id: 'rcpt_empty_previews', tenantId: 'tnt_a' })
    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  // -------------------------------------------------------------------------
  // Required: store, read back as the owner
  // -------------------------------------------------------------------------

  it('round-trips a preview through the database as the owning tenant', async () => {
    const previews = { request: '{"api_key":"<redacted>"}', response: '{"items":[]}' }

    const stored = await withTenant(db.pool, 'tnt_a', (tx) =>
      storePreviews(tx, {
        masterKey: TEST_MASTER_KEY,
        tenantId: 'tnt_a',
        receiptId: 'rcpt_a',
        registration: 'full',
        previews,
      }),
    )
    expect(stored).toBe(true)

    const loaded = await withTenant(db.pool, 'tnt_a', (tx) =>
      loadPreviews(tx, { masterKey: TEST_MASTER_KEY, tenantId: 'tnt_a', receiptId: 'rcpt_a' }),
    )

    expect(loaded).toEqual(previews)
  })

  it('reads nothing back for a receipt that has no stored payload', async () => {
    const loaded = await withTenant(db.pool, 'tnt_a', (tx) =>
      loadPreviews(tx, { masterKey: TEST_MASTER_KEY, tenantId: 'tnt_a', receiptId: 'rcpt_empty_previews' }),
    )

    expect(loaded).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Required: tenant A cannot read tenant B's ciphertext
  // -------------------------------------------------------------------------

  it('hides another tenant\'s payload behind row-level security', async () => {
    await withTenant(db.pool, 'tnt_b', (tx) =>
      storePreviews(tx, {
        masterKey: TEST_MASTER_KEY,
        tenantId: 'tnt_b',
        receiptId: 'rcpt_b',
        registration: 'full',
        previews: { request: '{"secret":"tenant-b-only"}', response: null },
      }),
    )

    // Tenant A asking for tenant B's receipt id: RLS returns no row, so there is nothing
    // to decrypt.
    const asA = await withTenant(db.pool, 'tnt_a', (tx) =>
      loadPreviews(tx, { masterKey: TEST_MASTER_KEY, tenantId: 'tnt_a', receiptId: 'rcpt_b' }),
    )
    expect(asA).toBeNull()

    const asB = await withTenant(db.pool, 'tnt_b', (tx) =>
      loadPreviews(tx, { masterKey: TEST_MASTER_KEY, tenantId: 'tnt_b', receiptId: 'rcpt_b' }),
    )
    expect(asB).toEqual({ request: '{"secret":"tenant-b-only"}', response: null })
  })

  it('cannot decrypt another tenant\'s ciphertext even with the raw bytes', async () => {
    // The second line of defence. Reach past RLS entirely - as the table owner - and the
    // crypto still refuses, because the key is derived from the tenant id.
    const raw = await db.asOwner(() =>
      db.unscoped<{ encrypted: Uint8Array }>('SELECT encrypted FROM payloads WHERE receipt_id = $1', ['rcpt_b']),
    )

    const envelope = new Uint8Array(raw[0]!.encrypted)

    expect(() => decryptPreviews(TEST_MASTER_KEY, 'tnt_a', envelope)).toThrow(DecryptionError)
    expect(decryptPreviews(TEST_MASTER_KEY, 'tnt_b', envelope)).toEqual({
      request: '{"secret":"tenant-b-only"}',
      response: null,
    })
  })

  it('stores an encrypted blob that does not contain the plaintext', async () => {
    const raw = await db.asOwner(() =>
      db.unscoped<{ encrypted: Uint8Array }>('SELECT encrypted FROM payloads WHERE receipt_id = $1', ['rcpt_a']),
    )

    // The whole point: the buyer's data is not readable in the database.
    expect(Buffer.from(raw[0]!.encrypted).toString('utf8')).not.toContain('api_key')
  })

  // -------------------------------------------------------------------------
  // Registration modes
  // -------------------------------------------------------------------------

  it('stores nothing for hash-only registration', async () => {
    const stored = await withTenant(db.pool, 'tnt_a', (tx) =>
      storePreviews(tx, {
        masterKey: TEST_MASTER_KEY,
        tenantId: 'tnt_a',
        receiptId: 'rcpt_hash_only',
        registration: 'hash-only',
        previews: { request: '{"should":"never be stored"}', response: null },
      }),
    )

    expect(stored).toBe(false)

    const rows = await db.asOwner(() =>
      db.unscoped('SELECT receipt_id FROM payloads WHERE receipt_id = $1', ['rcpt_hash_only']),
    )
    expect(rows).toEqual([])
  })

  it('stores nothing for local registration', async () => {
    const stored = await withTenant(db.pool, 'tnt_a', (tx) =>
      storePreviews(tx, {
        masterKey: TEST_MASTER_KEY,
        tenantId: 'tnt_a',
        receiptId: 'rcpt_empty_previews',
        registration: 'local',
        previews: { request: 'x', response: 'y' },
      }),
    )

    expect(stored).toBe(false)
  })

  it('stores nothing when both previews are null, even in full mode', async () => {
    const stored = await withTenant(db.pool, 'tnt_a', (tx) =>
      storePreviews(tx, {
        masterKey: TEST_MASTER_KEY,
        tenantId: 'tnt_a',
        receiptId: 'rcpt_empty_previews',
        registration: 'full',
        previews: { request: null, response: null },
      }),
    )

    expect(stored).toBe(false)
  })

  it('sets a seven-day expiry', async () => {
    const rows = await db.asOwner(() =>
      db.unscoped<{ days: number }>(
        `SELECT EXTRACT(EPOCH FROM (expires_at - now())) / 86400 AS days FROM payloads WHERE receipt_id = $1`,
        ['rcpt_a'],
      ),
    )

    expect(Number(rows[0]?.days)).toBeGreaterThan(6.9)
    expect(Number(rows[0]?.days)).toBeLessThanOrEqual(7)
  })

  it('does not overwrite an existing payload on a repeat store', async () => {
    await withTenant(db.pool, 'tnt_b', (tx) =>
      storePreviews(tx, {
        masterKey: TEST_MASTER_KEY,
        tenantId: 'tnt_b',
        receiptId: 'rcpt_b',
        registration: 'full',
        previews: { request: '{"overwritten":true}', response: null },
      }),
    )

    const loaded = await withTenant(db.pool, 'tnt_b', (tx) =>
      loadPreviews(tx, { masterKey: TEST_MASTER_KEY, tenantId: 'tnt_b', receiptId: 'rcpt_b' }),
    )

    // First write wins, matching receipt idempotency.
    expect(loaded).toEqual({ request: '{"secret":"tenant-b-only"}', response: null })
  })

  it('refuses a raw insert for another tenant, via RLS', async () => {
    await expect(
      withTenant(db.pool, 'tnt_a', (tx) =>
        insertEncryptedPayload(tx, {
          receiptId: 'rcpt_b',
          tenantId: 'tnt_b',
          encrypted: new Uint8Array([1, 2, 3]),
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})
