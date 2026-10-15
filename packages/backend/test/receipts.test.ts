/**
 * `GET /v1/receipts/:id` and `GET /v1/receipts/:id/verify`.
 *
 * The two endpoints have opposite security postures, which is the point of testing them
 * together: the read is tenant-scoped and must not leak across tenants, while verification
 * is public and must work with no credentials at all - and must never disclose the receipt
 * it is verifying.
 *
 * Tampering is done with raw SQL through `db.asOwner`, bypassing RLS. There is deliberately
 * no application path that can modify a stored receipt, so the only way to construct a
 * corrupted one is to reach past the app entirely.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { API_KEY_HEADER } from '../src/auth.js'
import type { SigningKey } from '../src/crypto/sign.js'
import { withTenant } from '../src/db/client.js'
import { publishSigningKey } from '../src/db/keys.js'
import { selectReceipt } from '../src/db/receipts.js'
import { createTestDb, seedTenant, type TestDb } from './helpers/pg.js'
import { TEST_MASTER_KEY, fixedClock, makeIngestEvent, testSigningKey } from './helpers/keys.js'

const KEY_A = 'sk_test_receipts_tenant_a'
const KEY_B = 'sk_test_receipts_tenant_b'
const SIGNED_AT = '2026-10-15T12:00:00.000Z'

async function postBatch(
  app: ReturnType<typeof createApp>,
  apiKey: string,
  receiptIds: string[],
): Promise<Response> {
  const events = receiptIds.map((receiptId, index) =>
    makeIngestEvent({ receiptId, eventId: `evt_${receiptId}_${index}` }),
  )

  return app.request('/v1/ingest/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: apiKey },
    body: JSON.stringify({ events }),
  })
}

describe('receipt retrieval and verification', () => {
  let db: TestDb
  let signer: SigningKey
  let app: ReturnType<typeof createApp>
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    signer = await testSigningKey()

    await seedTenant(db, { id: 'tnt_a', apiKey: KEY_A, name: 'Tenant A' })
    await seedTenant(db, { id: 'tnt_b', apiKey: KEY_B, name: 'Tenant B' })

    // Verification resolves `keyId` against the published keys, so the signing key has to
    // be published for a receipt to be verifiable at all.
    await publishSigningKey(db.pool, signer)

    app = createApp({
      db: db.pool,
      signer,
      masterKey: TEST_MASTER_KEY,
      version: 'test',
      now: fixedClock(SIGNED_AT),
      onError: () => {},
    })

    await postBatch(app, KEY_A, ['rcpt_a1', 'rcpt_a2'])
    await postBatch(app, KEY_B, ['rcpt_b1'])
    // Dedicated receipts, so destructive tests do not disturb the shared fixtures.
    await postBatch(app, KEY_A, ['rcpt_tampered', 'rcpt_corrupt', 'rcpt_unpublished'])

    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  // -------------------------------------------------------------------------
  // Required: GET /v1/receipts/:id
  // -------------------------------------------------------------------------

  it('returns the full receipt to its owner', async () => {
    const response = await app.request('/v1/receipts/rcpt_a1', { headers: { [API_KEY_HEADER]: KEY_A } })

    expect(response.status).toBe(200)

    const body = (await response.json()) as unknown
    const stored = await withTenant(db.pool, 'tnt_a', (tx) => selectReceipt(tx, 'rcpt_a1'))

    expect(body).toEqual(stored)
    expect((body as { serverSignature: string }).serverSignature.startsWith('ed25519:')).toBe(true)
    expect((body as { tenantId: string }).tenantId).toBe('tnt_a')
  })

  it('returns 404 - not 403 - for another tenant\'s receipt', async () => {
    // A 403 would confirm the id exists, turning the endpoint into an existence oracle
    // over other tenants' receipts.
    const response = await app.request('/v1/receipts/rcpt_a1', { headers: { [API_KEY_HEADER]: KEY_B } })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'receipt_not_found' })
  })

  it('still returns the tenant\'s own receipt, so the 404 above is about ownership', async () => {
    const response = await app.request('/v1/receipts/rcpt_b1', { headers: { [API_KEY_HEADER]: KEY_B } })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { receiptId: string }).receiptId).toBe('rcpt_b1')
  })

  it('returns 401 with no key', async () => {
    const response = await app.request('/v1/receipts/rcpt_a1')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'missing_api_key' })
  })

  it('returns 404 for a receipt that does not exist', async () => {
    const response = await app.request('/v1/receipts/rcpt_no_such_thing', { headers: { [API_KEY_HEADER]: KEY_A } })

    expect(response.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // Required: GET /v1/receipts/:id/verify
  // -------------------------------------------------------------------------

  it('verifies a valid receipt with no authentication', async () => {
    const response = await app.request('/v1/receipts/rcpt_a1/verify')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      valid: true,
      receiptId: 'rcpt_a1',
      signedAt: SIGNED_AT,
      attestation: 'platform',
      keyId: signer.keyId,
    })
  })

  it('verifies another tenant\'s receipt too, because verification is public', async () => {
    // Deliberate: a receipt is meant to convince a third party who has no account.
    const response = await app.request('/v1/receipts/rcpt_b1/verify')

    expect(response.status).toBe(200)
    expect(((await response.json()) as { valid: boolean }).valid).toBe(true)
  })

  it('does not disclose the receipt it verifies', async () => {
    // Anyone who guesses an id learns whether it is real and little else. The receipt
    // contents are not returned, so the id alone is not a disclosure.
    const body = (await (await app.request('/v1/receipts/rcpt_a1/verify')).json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(['attestation', 'keyId', 'receiptId', 'signedAt', 'valid'])
    expect(JSON.stringify(body)).not.toContain('sha256:')
    expect(body['responseHash']).toBeUndefined()
    expect(body['validation']).toBeUndefined()
  })

  it('reports valid: false with 200 for a tampered receipt', async () => {
    const before = await app.request('/v1/receipts/rcpt_tampered/verify')
    expect(((await before.json()) as { valid: boolean }).valid).toBe(true)

    // Change a field the signature covers without touching the signature.
    await db.asOwner(() =>
      db.unscoped('UPDATE receipts SET response_hash = $1 WHERE id = $2', [
        `sha256:${'f'.repeat(64)}`,
        'rcpt_tampered',
      ]),
    )

    const after = await app.request('/v1/receipts/rcpt_tampered/verify')

    // A failed verification is a successful response, not an error.
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({
      valid: false,
      receiptId: 'rcpt_tampered',
      signedAt: SIGNED_AT,
      attestation: 'platform',
      keyId: signer.keyId,
    })
  })

  it('reports valid: false, without throwing, for a corrupted signature', async () => {
    const corruptions: [string, string | null][] = [
      ['truncated base64', 'ed25519:AAAA'],
      ['bad base64', 'ed25519:!!!!'],
      ['wrong prefix', 'rsa:AAAA'],
      ['empty', ''],
      ['null', null],
      ['random text', 'not a signature at all'],
    ]

    for (const [label, serverSignature] of corruptions) {
      await db.asOwner(() =>
        db.unscoped('UPDATE receipts SET server_signature = $1 WHERE id = $2', [serverSignature, 'rcpt_corrupt']),
      )

      const response = await app.request('/v1/receipts/rcpt_corrupt/verify')

      expect(response.status, label).toBe(200)
      expect(((await response.json()) as { valid: boolean }).valid, label).toBe(false)
    }
  })

  it('reports valid: false when the receipt names a key that was never published', async () => {
    await db.asOwner(() =>
      db.unscoped(`UPDATE receipts SET key_id = 'k_never_published' WHERE id = $1`, ['rcpt_unpublished']),
    )

    const response = await app.request('/v1/receipts/rcpt_unpublished/verify')

    expect(response.status).toBe(200)
    expect(((await response.json()) as { valid: boolean }).valid).toBe(false)
  })

  it('reports valid: false when the stored validation object is unusable', async () => {
    // Canonicalization is what the signature covers; if the stored JSON cannot be
    // canonicalized, verification must answer "no" rather than propagate.
    await db.asOwner(() =>
      db.unscoped(`UPDATE receipts SET validation = 'null'::jsonb WHERE id = $1`, ['rcpt_corrupt']),
    )

    const response = await app.request('/v1/receipts/rcpt_corrupt/verify')

    expect(response.status).toBe(200)
    expect(((await response.json()) as { valid: boolean }).valid).toBe(false)
  })

  it('returns 404 for verifying a receipt that does not exist', async () => {
    const response = await app.request('/v1/receipts/rcpt_no_such_thing/verify')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'receipt_not_found' })
  })

  it('applies row-level security to the read but not to verification', async () => {
    // The same receipt: invisible through the tenant-scoped read for tenant B, yet
    // verifiable by anyone. That asymmetry is the design, not a leak.
    const read = await app.request('/v1/receipts/rcpt_a1', { headers: { [API_KEY_HEADER]: KEY_B } })
    const verify = await app.request('/v1/receipts/rcpt_a1/verify')

    expect(read.status).toBe(404)
    expect(verify.status).toBe(200)
  })
})
