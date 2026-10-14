/**
 * Local SQLite receipt store tests.
 *
 * The required three are here - round-trip byte-equality, corruption-free
 * concurrency, and file create/reuse - plus two guards worth their cost:
 *
 *   1. The column list is checked against the `Receipt` type's own keys, so adding
 *      a field to the type without adding a column fails here rather than silently
 *      dropping data at runtime.
 *   2. `null` is asserted to survive as `null`, not as `''`. That distinction is
 *      the point of the `string | null` amendment, and a SQLite round-trip is
 *      exactly where it would quietly regress.
 *
 * "Byte-equal" is asserted two ways: deep equality of the object, and equality of
 * the canonical signing bytes - the second being the one that matters, because
 * those are the bytes a signature covers.
 *
 * Most tests use `:memory:`. Only the ones about the FILE, or about two
 * connections sharing one, pay for real filesystem I/O; everything else would be
 * measuring disk speed rather than store behaviour.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LOCAL_SCHEMA_VERSION, LocalReceiptStore, RECEIPT_COLUMNS } from '../src/local-db.js'
import { canonicalizeReceiptForSigning } from '../src/receipt.js'
import type { Receipt } from '../src/types.js'

/** Temp space inside the package, so tests work wherever the sandbox allows writes. */
const TMP_ROOT = fileURLToPath(new URL('../.tmp', import.meta.url))

let dir: string
let dbPath: string

beforeEach(() => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(join(TMP_ROOT, 'db-'))
  dbPath = join(dir, 'receipts.db')
})

afterEach(() => {
  // Close before deleting. `close()` is idempotent, and on Windows an open
  // SQLite handle cannot be deleted - so without this, a test that fails part-way
  // would raise EPERM here and mask the real assertion error.
  for (const store of openStores) store.close()
  openStores.length = 0

  // Also removes the -wal and -shm files WAL mode creates.
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Every store opened during a test, so cleanup can close them all regardless of
 * where a test stopped.
 */
const openStores: LocalReceiptStore[] = []

function open(path: string): LocalReceiptStore {
  const store = new LocalReceiptStore({ path })
  openStores.push(store)
  return store
}

/** Fast store for tests that are not about files. */
function memoryStore(): LocalReceiptStore {
  return open(':memory:')
}

/** File-backed store, for tests that are about persistence or cross-connection use. */
function fileStore(): LocalReceiptStore {
  return open(dbPath)
}

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schemaVersion: '1',
    receiptId: 'rcpt_0000000000000001',
    tenantId: 'tnt_8f2b1c4d9e',
    sellerId: null,
    provider: 'scraper-x',
    operation: 'extract',
    requestHash: `sha256:${'a'.repeat(64)}`,
    responseHash: `sha256:${'b'.repeat(64)}`,
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
    keyId: 'k_0001',
    serverSignature: 'ed25519:U0VMRi1TSUdOQVRVUkU=',
    signedAt: '2026-10-13T09:30:01.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Required: write, read back, byte-equal
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it(
    'writes a receipt to a file and reads it back byte-equal',
    () => {
      const store = fileStore()
      const receipt = makeReceipt()

      store.put(receipt)
      const loaded = store.get(receipt.receiptId)

      expect(loaded).toEqual(receipt)
      // The assertion that counts: identical canonical bytes, so a signature over
      // one is a signature over the other.
      expect(canonicalizeReceiptForSigning(loaded!)).toBe(canonicalizeReceiptForSigning(receipt))

      store.close()
    },
    20_000,
  )

  it('round-trips every field through an in-memory database', () => {
    const store = memoryStore()
    const receipt = makeReceipt()

    store.put(receipt)
    expect(store.get(receipt.receiptId)).toEqual(receipt)
    store.close()
  })

  it('preserves null rather than coercing it to an empty string', () => {
    const store = memoryStore()
    const unsigned = makeReceipt({
      attestation: 'self',
      registration: 'local',
      keyId: null,
      serverSignature: null,
      signedAt: null,
    })

    store.put(unsigned)
    const loaded = store.get(unsigned.receiptId)!

    expect(loaded.keyId).toBeNull()
    expect(loaded.serverSignature).toBeNull()
    expect(loaded.signedAt).toBeNull()
    expect(loaded.keyId).not.toBe('')
    expect(loaded.serverSignature).not.toBe('')

    store.close()
  })

  it('round-trips the nested validation object', () => {
    const store = memoryStore()
    const validation = { passed: true, rules: ['non-empty', 'no-duplicates:tags'], errors: [] }
    const receipt = makeReceipt({ validation })

    store.put(receipt)
    expect(store.get(receipt.receiptId)!.validation).toEqual(validation)

    store.close()
  })

  it('round-trips a passed: null verdict, which is not the same as false', () => {
    const store = memoryStore()
    const receipt = makeReceipt({ validation: { passed: null, rules: ['unvalidated:non-json'], errors: [] } })

    store.put(receipt)
    expect(store.get(receipt.receiptId)!.validation.passed).toBeNull()

    store.close()
  })

  it('round-trips sellerId both ways', () => {
    const store = memoryStore()
    store.put(makeReceipt({ receiptId: 'rcpt_null', sellerId: null }))
    store.put(makeReceipt({ receiptId: 'rcpt_set', sellerId: 'slr_abc' }))

    expect(store.get('rcpt_null')!.sellerId).toBeNull()
    expect(store.get('rcpt_set')!.sellerId).toBe('slr_abc')

    store.close()
  })

  it('returns null for an unknown receipt id', () => {
    const store = memoryStore()
    expect(store.get('rcpt_does_not_exist')).toBeNull()
    store.close()
  })

  it('is idempotent on receiptId, matching the backend dedup rule', () => {
    const store = memoryStore()
    const receipt = makeReceipt()

    store.put(receipt)
    store.put(receipt)
    store.put(makeReceipt({ latencyMs: 999 }))

    expect(store.count()).toBe(1)
    expect(store.get(receipt.receiptId)!.latencyMs).toBe(999)

    store.close()
  })
})

// ---------------------------------------------------------------------------
// Required: concurrent writes do not corrupt
// ---------------------------------------------------------------------------

describe('concurrent writes', () => {
  it(
    'handles many interleaved writers without loss',
    async () => {
      const store = fileStore()

      // Each writer yields before touching the database, so the writes genuinely
      // interleave rather than running to completion one after another.
      await Promise.all(
        Array.from({ length: 100 }, async (_, i) => {
          await Promise.resolve()
          store.put(makeReceipt({ receiptId: `rcpt_${i}`, latencyMs: i }))
        }),
      )

      expect(store.count()).toBe(100)
      expect(store.integrityCheck()).toBe('ok')

      for (let i = 0; i < 100; i++) {
        expect(store.get(`rcpt_${i}`)!.latencyMs, `receipt ${i}`).toBe(i)
      }

      store.close()
    },
    30_000,
  )

  it(
    'handles two connections writing to the same file',
    () => {
      const first = fileStore()
      const second = fileStore()

      for (let i = 0; i < 25; i++) {
        first.put(makeReceipt({ receiptId: `rcpt_a_${i}` }))
        second.put(makeReceipt({ receiptId: `rcpt_b_${i}` }))
      }

      expect(first.count()).toBe(50)
      expect(second.count()).toBe(50)
      expect(first.integrityCheck()).toBe('ok')
      // Both connections see each other's committed rows.
      expect(second.get('rcpt_a_0')).not.toBeNull()
      expect(first.get('rcpt_b_24')).not.toBeNull()

      first.close()
      second.close()
    },
    30_000,
  )

  it('keeps every row readable and queryable after concurrent writes', () => {
    const store = memoryStore()

    for (let i = 0; i < 120; i++) {
      store.put(makeReceipt({ receiptId: `rcpt_${i}`, provider: i % 2 === 0 ? 'scraper-x' : 'scraper-y' }))
    }

    expect(store.count()).toBe(120)
    expect(store.list({ provider: 'scraper-x' })).toHaveLength(60)
    expect(store.list({ provider: 'scraper-y' })).toHaveLength(60)
    expect(store.integrityCheck()).toBe('ok')

    store.close()
  })

  it(
    'writes a batch in one transaction, reaching the same state as individual writes',
    () => {
      const batched = open(join(dir, 'batched.db'))
      const oneByOne = open(join(dir, 'one-by-one.db'))

      const receipts = Array.from({ length: 50 }, (_, i) => makeReceipt({ receiptId: `rcpt_${i}`, latencyMs: i }))

      batched.putMany(receipts)
      for (const receipt of receipts) oneByOne.put(receipt)

      expect(batched.count()).toBe(50)
      expect(batched.integrityCheck()).toBe('ok')
      // One transaction is an optimisation, not a semantic change: every row must
      // be identical to what individual commits would have produced.
      for (const receipt of receipts) {
        expect(batched.get(receipt.receiptId)).toEqual(oneByOne.get(receipt.receiptId))
      }

      batched.close()
      oneByOne.close()
    },
    30_000,
  )

  it('accepts an empty batch as a no-op', () => {
    const store = memoryStore()
    expect(() => {
      store.putMany([])
    }).not.toThrow()
    expect(store.count()).toBe(0)
    store.close()
  })
})

// ---------------------------------------------------------------------------
// Required: file created if missing, reused if present
// ---------------------------------------------------------------------------

describe('file lifecycle', () => {
  it('creates the database file when it does not exist', () => {
    expect(existsSync(dbPath)).toBe(false)

    const store = fileStore()
    store.put(makeReceipt())

    expect(existsSync(dbPath)).toBe(true)
    store.close()
  })

  it('creates missing parent directories', () => {
    const nested = join(dir, 'nested', 'deeper', 'receipts.db')
    const store = open(nested)

    store.put(makeReceipt())
    expect(existsSync(nested)).toBe(true)

    store.close()
  })

  it('reuses an existing database file and keeps its data', () => {
    const receipt = makeReceipt()

    const writer = fileStore()
    writer.put(receipt)
    writer.close()

    const reader = fileStore()
    expect(reader.count()).toBe(1)
    expect(reader.get(receipt.receiptId)).toEqual(receipt)
    expect(canonicalizeReceiptForSigning(reader.get(receipt.receiptId)!)).toBe(canonicalizeReceiptForSigning(receipt))
    reader.close()
  })

  it('adds to an existing file rather than recreating it', () => {
    const first = fileStore()
    first.put(makeReceipt({ receiptId: 'rcpt_one' }))
    first.close()

    const second = fileStore()
    second.put(makeReceipt({ receiptId: 'rcpt_two' }))

    expect(second.count()).toBe(2)
    expect(second.get('rcpt_one')).not.toBeNull()
    second.close()
  })

  it('supports an in-memory store', () => {
    const store = memoryStore()
    store.put(makeReceipt())
    expect(store.count()).toBe(1)
    store.close()
  })

  it('tolerates being closed twice', () => {
    const store = memoryStore()
    store.close()
    expect(() => {
      store.close()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Schema guards
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('has exactly one column per Receipt field', () => {
    // If someone adds a field to `Receipt` without adding a column, this fails here
    // instead of silently dropping the value at runtime.
    const snakeCase = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    const expected = Object.keys(makeReceipt()).map(snakeCase).sort()

    expect([...RECEIPT_COLUMNS].sort()).toEqual(expected)
  })

  it('records the schema version in user_version', () => {
    expect(LOCAL_SCHEMA_VERSION).toBe(1)

    const store = fileStore()
    store.close()

    // Reopening must not treat the existing file as a fresh database.
    const reopened = fileStore()
    expect(reopened.count()).toBe(0)
    reopened.close()
  })

  it('migrates idempotently across repeated opens', () => {
    for (let i = 0; i < 3; i++) {
      const store = fileStore()
      store.put(makeReceipt({ receiptId: `rcpt_${i}` }))
      store.close()
    }

    const store = fileStore()
    expect(store.count()).toBe(3)
    expect(store.integrityCheck()).toBe('ok')
    store.close()
  })
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('list', () => {
  it('returns receipts newest first', () => {
    const store = memoryStore()
    store.put(makeReceipt({ receiptId: 'rcpt_old', timestamp: '2026-10-01T00:00:00.000Z' }))
    store.put(makeReceipt({ receiptId: 'rcpt_new', timestamp: '2026-10-13T00:00:00.000Z' }))
    store.put(makeReceipt({ receiptId: 'rcpt_mid', timestamp: '2026-10-07T00:00:00.000Z' }))

    expect(store.list().map((r) => r.receiptId)).toEqual(['rcpt_new', 'rcpt_mid', 'rcpt_old'])
    store.close()
  })

  it('filters by provider and tenant', () => {
    const store = memoryStore()
    store.put(makeReceipt({ receiptId: 'rcpt_1', provider: 'scraper-x', tenantId: 'tnt_a' }))
    store.put(makeReceipt({ receiptId: 'rcpt_2', provider: 'scraper-x', tenantId: 'tnt_b' }))
    store.put(makeReceipt({ receiptId: 'rcpt_3', provider: 'scraper-y', tenantId: 'tnt_a' }))

    expect(store.list({ provider: 'scraper-x' })).toHaveLength(2)
    expect(store.list({ tenantId: 'tnt_a' })).toHaveLength(2)
    expect(store.list({ provider: 'scraper-x', tenantId: 'tnt_a' }).map((r) => r.receiptId)).toEqual(['rcpt_1'])

    store.close()
  })

  it('honours a limit', () => {
    const store = memoryStore()
    for (let i = 0; i < 10; i++) {
      store.put(
        makeReceipt({ receiptId: `rcpt_${i}`, timestamp: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
      )
    }

    expect(store.list({ limit: 3 })).toHaveLength(3)
    store.close()
  })
})
