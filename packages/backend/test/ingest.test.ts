/**
 * `POST /v1/ingest/batch`.
 *
 * The tests that matter most here are the round-trip ones: a receipt is signed, stored,
 * read back out of Postgres, and then verified against the public key the server
 * publishes. That is the whole product in one assertion, and it catches the failure modes
 * that unit tests cannot - a timestamp losing precision through `timestamptz`, a column
 * mapped to the wrong field, a `jsonb` value coming back reshaped. Any of those changes
 * the bytes the signature covers, and verification fails.
 */

import { MAX_EVENTS_PER_BATCH, type Receipt } from '@notched/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { API_KEY_HEADER } from '../src/auth.js'
import { publicKeyBase64, verifyReceipt, type SigningKey } from '../src/crypto/sign.js'
import { withTenant, type DbPool } from '../src/db/client.js'
import { selectReceipt } from '../src/db/receipts.js'
import { createTestDb, seedTenant, type TestDb } from './helpers/pg.js'
import { fixedClock, makeIngestEvent, testSigningKey, TEST_MASTER_KEY } from './helpers/keys.js'

const KEY_A = 'sk_test_ingest_tenant_a'
const SIGNED_AT = '2026-10-15T12:00:00.000Z'

async function postBatch(
  app: ReturnType<typeof createApp>,
  apiKey: string | null,
  events: unknown[],
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey !== null) headers[API_KEY_HEADER] = apiKey

  return app.request('/v1/ingest/batch', { method: 'POST', headers, body: JSON.stringify({ events }) })
}

async function readReceipt(db: TestDb, tenantId: string, receiptId: string): Promise<Receipt | null> {
  return withTenant(db.pool, tenantId, (tx) => selectReceipt(tx, receiptId))
}

async function countReceipts(db: TestDb, tenantId: string): Promise<number> {
  const rows = await withTenant(db.pool, tenantId, (tx) => tx.query('SELECT id FROM receipts'))
  return rows.rows.length
}

describe('POST /v1/ingest/batch', () => {
  let db: TestDb
  let signer: SigningKey
  let app: ReturnType<typeof createApp>
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    signer = await testSigningKey()
    await seedTenant(db, { id: 'tnt_a', apiKey: KEY_A, name: 'Tenant A' })
    app = createApp({ masterKey: TEST_MASTER_KEY, db: db.pool, signer, version: 'test', now: fixedClock(SIGNED_AT), onError: () => {} })
    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  // -------------------------------------------------------------------------
  // Required: a batch of three
  // -------------------------------------------------------------------------

  it('accepts a batch of 3 and returns 3 distinct receipts', async () => {
    const events = [
      makeIngestEvent({ receiptId: 'rcpt_batch_1', eventId: 'evt_batch_1' }),
      makeIngestEvent({ receiptId: 'rcpt_batch_2', eventId: 'evt_batch_2' }),
      makeIngestEvent({ receiptId: 'rcpt_batch_3', eventId: 'evt_batch_3' }),
    ]

    const response = await postBatch(app, KEY_A, events)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { accepted: number; rejected: number; receipts: string[] }
    expect(body.accepted).toBe(3)
    expect(body.rejected).toBe(0)
    expect(body.receipts).toHaveLength(3)
    // Distinct: a bug that reused one id would make these collapse.
    expect(new Set(body.receipts).size).toBe(3)
    expect(body.receipts).toEqual(['rcpt_batch_1', 'rcpt_batch_2', 'rcpt_batch_3'])
  })

  it('signs every receipt in the batch', async () => {
    const receipts = await Promise.all(
      ['rcpt_batch_1', 'rcpt_batch_2', 'rcpt_batch_3'].map((id) => readReceipt(db, 'tnt_a', id)),
    )

    for (const receipt of receipts) {
      expect(receipt).not.toBeNull()
      expect(receipt!.serverSignature?.startsWith('ed25519:')).toBe(true)
      expect(receipt!.keyId).toBe(signer.keyId)
      // The backend signed it, so `platform` is the truthful attestation here.
      expect(receipt!.attestation).toBe('platform')
      expect(receipt!.signedAt).toBe(SIGNED_AT)
      expect(receipt!.tenantId).toBe('tnt_a')
    }
  })

  // -------------------------------------------------------------------------
  // Required: verify offline with the published key
  // -------------------------------------------------------------------------

  it('produces receipts that verify against the key from /v1/keys/current', async () => {
    const keysResponse = await app.request('/v1/keys/current')
    const { keyId, algorithm, publicKey } = (await keysResponse.json()) as {
      keyId: string
      algorithm: string
      publicKey: string
    }

    expect(algorithm).toBe('ed25519')
    expect(keyId).toBe(signer.keyId)
    expect(publicKey).toBe(publicKeyBase64(signer))

    // Read back OUT OF THE DATABASE, exactly as a verifier would receive it, and verify
    // with nothing but the receipt JSON and the published key.
    for (const id of ['rcpt_batch_1', 'rcpt_batch_2', 'rcpt_batch_3']) {
      const receipt = await readReceipt(db, 'tnt_a', id)
      expect(receipt).not.toBeNull()
      expect(await verifyReceipt(receipt!, publicKey), `receipt ${id}`).toBe(true)
    }
  })

  it('fails verification when one byte of a stored receipt is altered', async () => {
    const { publicKey } = (await (await app.request('/v1/keys/current')).json()) as { publicKey: string }
    const receipt = (await readReceipt(db, 'tnt_a', 'rcpt_batch_1'))!

    expect(await verifyReceipt(receipt, publicKey)).toBe(true)
    expect(await verifyReceipt({ ...receipt, latencyMs: receipt.latencyMs + 1 }, publicKey)).toBe(false)
    expect(await verifyReceipt({ ...receipt, responseHash: `sha256:${'f'.repeat(64)}` }, publicKey)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Required: idempotency
  // -------------------------------------------------------------------------

  it('stores one row for a receiptId sent twice, and both responses reference it', async () => {
    const event = makeIngestEvent({ receiptId: 'rcpt_idempotent', eventId: 'evt_idempotent' })

    const first = (await (await postBatch(app, KEY_A, [event])).json()) as {
      accepted: number
      receipts: string[]
    }
    const second = (await (await postBatch(app, KEY_A, [event])).json()) as {
      accepted: number
      receipts: string[]
    }

    expect(first.receipts).toEqual(['rcpt_idempotent'])
    expect(second.receipts).toEqual(['rcpt_idempotent'])
    expect(first.accepted).toBe(1)
    expect(second.accepted).toBe(1)

    const rows = await withTenant(db.pool, 'tnt_a', (tx) =>
      tx.query('SELECT id FROM receipts WHERE id = $1', ['rcpt_idempotent']),
    )
    expect(rows.rows).toHaveLength(1)
  })

  it('never overwrites a stored receipt, even if the re-send differs', async () => {
    // Idempotency means first-write-wins. A receipt is a signed artefact: a second write
    // that changed it would let a receipt be amended after the fact.
    const original = makeIngestEvent({ receiptId: 'rcpt_immutable', latencyMs: 111 })
    await postBatch(app, KEY_A, [original])

    const changed = makeIngestEvent({
      receiptId: 'rcpt_immutable',
      latencyMs: 999,
      validation: { passed: true, rules: [], errors: [] },
    })
    await postBatch(app, KEY_A, [changed])

    const stored = (await readReceipt(db, 'tnt_a', 'rcpt_immutable'))!
    expect(stored.latencyMs).toBe(111)
    expect(stored.validation.passed).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Required: batch limit
  // -------------------------------------------------------------------------

  it('rejects a batch of 101 with 413 and a clear error code', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) =>
      makeIngestEvent({ receiptId: `rcpt_over_${i}`, eventId: `evt_over_${i}` }),
    )

    const response = await postBatch(app, KEY_A, events)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'batch_too_large',
      max: MAX_EVENTS_PER_BATCH,
      received: 101,
    })
  })

  it(
    'accepts a batch of exactly 100, which is the boundary',
    async () => {
      const events = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) =>
        makeIngestEvent({ receiptId: `rcpt_limit_${i}`, eventId: `evt_limit_${i}` }),
      )

      const response = await postBatch(app, KEY_A, events)
      expect(response.status).toBe(200)
      expect(((await response.json()) as { accepted: number }).accepted).toBe(100)
    },
    60_000,
  )

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('requires an API key', async () => {
    const response = await postBatch(app, null, [makeIngestEvent()])

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'missing_api_key' })
  })

  it('rejects an unknown API key before reading the body', async () => {
    const response = await postBatch(app, 'sk_test_nope', [makeIngestEvent()])

    expect(response.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Malformed input
  // -------------------------------------------------------------------------

  it('rejects a malformed event without failing the whole request', async () => {
    const response = await postBatch(app, KEY_A, [{ not: 'an event' }])

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 0, rejected: 1, receipts: [] })
  })

  it('counts per-event failures alongside per-event successes', async () => {
    const events = [
      makeIngestEvent({ receiptId: 'rcpt_mixed_ok', eventId: 'evt_mixed_ok' }),
      { receiptId: 'rcpt_mixed_bad' }, // missing everything else
      makeIngestEvent({ receiptId: 'rcpt_mixed_ok2', eventId: 'evt_mixed_ok2' }),
    ]

    const body = (await (await postBatch(app, KEY_A, events)).json()) as {
      accepted: number
      rejected: number
      receipts: string[]
    }

    expect(body.accepted).toBe(2)
    expect(body.rejected).toBe(1)
    expect(body.receipts).toEqual(['rcpt_mixed_ok', 'rcpt_mixed_ok2'])
  })

  it('rejects an event with a missing required field', async () => {
    const event = makeIngestEvent({ receiptId: 'rcpt_bad_shape' })
    const broken = { ...event, latencyMs: undefined }

    expect(await (await postBatch(app, KEY_A, [broken])).json()).toEqual({
      accepted: 0,
      rejected: 1,
      receipts: [],
    })
  })

  it('rejects an event with an unusable registration mode', async () => {
    const event = makeIngestEvent({ receiptId: 'rcpt_bad_registration' })
    const broken = { ...event, metadata: { ...event.metadata, registration: 'everything' } }

    expect(await (await postBatch(app, KEY_A, [broken])).json()).toEqual({
      accepted: 0,
      rejected: 1,
      receipts: [],
    })
  })

  it('rejects a body whose events is not an array', async () => {
    const response = await app.request('/v1/ingest/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: KEY_A },
      body: JSON.stringify({ events: 'nope' }),
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_body')
  })

  it('rejects a body that is not JSON', async () => {
    const response = await app.request('/v1/ingest/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: KEY_A },
      body: 'not json at all',
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_json')
  })

  it('accepts an empty batch as a no-op', async () => {
    const response = await postBatch(app, KEY_A, [])

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 0, rejected: 0, receipts: [] })
  })

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  it('answers 503, not 200, when nothing could be stored', async () => {
    // The auth lookup is allowed through on the first connection; every event's
    // transaction then fails. A 200 here would tell the SDK's queue the batch succeeded,
    // so it would never retry and the telemetry would be lost silently.
    let connections = 0
    const flaky: DbPool = {
      async connect() {
        connections += 1
        if (connections === 1) return db.pool.connect()
        throw new Error('database went away')
      },
    }
    const flakyApp = createApp({ masterKey: TEST_MASTER_KEY, db: flaky, signer, version: 'test', onError: () => {} })

    const response = await postBatch(flakyApp, KEY_A, [makeIngestEvent({ receiptId: 'rcpt_unreachable' })])

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'storage_unavailable', accepted: 0, rejected: 1, receipts: [] })
  })

  it('does not throw when a whole batch fails', async () => {
    const broken: DbPool = {
      async connect() {
        throw new Error('database is unreachable')
      },
    }
    // Auth cannot even resolve, so this is the app-level 500 path, not the route's.
    const brokenApp = createApp({ masterKey: TEST_MASTER_KEY, db: broken, signer, version: 'test', onError: () => {} })

    const response = await postBatch(brokenApp, KEY_A, [makeIngestEvent()])
    expect(response.status).toBe(500)
  })

  // -------------------------------------------------------------------------
  // Value handling
  // -------------------------------------------------------------------------

  it('preserves a sentinel hash verbatim', async () => {
    // A receipt whose request body could not be hashed must still be signed and stored;
    // the sentinel is part of what is signed.
    const event = makeIngestEvent({ receiptId: 'rcpt_sentinel' })
    event.request.bodyHash = 'sentinel:unsupported-body-type'

    await postBatch(app, KEY_A, [event])

    const stored = (await readReceipt(db, 'tnt_a', 'rcpt_sentinel'))!
    expect(stored.requestHash).toBe('sentinel:unsupported-body-type')

    const { publicKey } = (await (await app.request('/v1/keys/current')).json()) as { publicKey: string }
    expect(await verifyReceipt(stored, publicKey)).toBe(true)
  })

  it('normalises the timestamp so the signed bytes survive a database round-trip', async () => {
    // A value with sub-millisecond precision would come back from `timestamptz` as
    // different text, and the signature would no longer match the reconstructed receipt.
    const event = makeIngestEvent({ receiptId: 'rcpt_precision', timestamp: '2026-10-15T11:59:59.123456Z' })
    await postBatch(app, KEY_A, [event])

    const stored = (await readReceipt(db, 'tnt_a', 'rcpt_precision'))!
    expect(stored.timestamp).toBe('2026-10-15T11:59:59.123Z')

    const { publicKey } = (await (await app.request('/v1/keys/current')).json()) as { publicKey: string }
    expect(await verifyReceipt(stored, publicKey)).toBe(true)
  })

  it('carries the validation verdict through unchanged', async () => {
    const event = makeIngestEvent({
      receiptId: 'rcpt_validation',
      validation: { passed: null, rules: ['unvalidated:oversize'], errors: [] },
    })
    await postBatch(app, KEY_A, [event])

    const stored = (await readReceipt(db, 'tnt_a', 'rcpt_validation'))!
    expect(stored.validation).toEqual({ passed: null, rules: ['unvalidated:oversize'], errors: [] })
  })

  it('records latency from the event', async () => {
    const event = makeIngestEvent({ receiptId: 'rcpt_latency', latencyMs: 4242 })
    await postBatch(app, KEY_A, [event])

    expect((await readReceipt(db, 'tnt_a', 'rcpt_latency'))!.latencyMs).toBe(4242)
  })

  it('stores receipts under the authenticated tenant, not one from the payload', async () => {
    // The event carries no tenant id at all; the tenant comes from the API key. This
    // asserts the receipt reflects that.
    const event = makeIngestEvent({ receiptId: 'rcpt_tenant' })
    await postBatch(app, KEY_A, [event])

    expect((await readReceipt(db, 'tnt_a', 'rcpt_tenant'))!.tenantId).toBe('tnt_a')
  })

  it('keeps every batch row readable', async () => {
    const before = await countReceipts(db, 'tnt_a')
    await postBatch(app, KEY_A, [
      makeIngestEvent({ receiptId: 'rcpt_final_1', eventId: 'evt_final_1' }),
      makeIngestEvent({ receiptId: 'rcpt_final_2', eventId: 'evt_final_2' }),
    ])

    expect(await countReceipts(db, 'tnt_a')).toBe(before + 2)
  })
})
