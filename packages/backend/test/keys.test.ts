/**
 * `GET /v1/keys` and `GET /v1/keys/current`.
 *
 * Both are public, and the properties worth testing are the ones that make offline
 * verification possible at all: the current key matches what the server signs with, the
 * key history accumulates, and a key id can never be silently repurposed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { publicKeyBase64, signingKeyFromSeed } from '../src/crypto/sign.js'
import { SigningKeyConflictError, listPublishedKeys, publishSigningKey } from '../src/db/keys.js'
import { createTestDb, type TestDb } from './helpers/pg.js'
import { OTHER_SEED, testSigningKey, TEST_MASTER_KEY } from './helpers/keys.js'

describe('the published key endpoints', () => {
  let db: TestDb
  let signer: Awaited<ReturnType<typeof testSigningKey>>
  let app: ReturnType<typeof createApp>
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    signer = await testSigningKey()
    app = createApp({ masterKey: TEST_MASTER_KEY, db: db.pool, signer, version: 'test', onError: () => {} })
    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  // -------------------------------------------------------------------------
  // /v1/keys/current
  // -------------------------------------------------------------------------

  it('serves the current key without authentication', async () => {
    const response = await app.request('/v1/keys/current')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      keyId: signer.keyId,
      algorithm: 'ed25519',
      publicKey: publicKeyBase64(signer),
    })
  })

  it('publishes a raw 32-byte public key as base64', async () => {
    const body = (await (await app.request('/v1/keys/current')).json()) as { publicKey: string }

    expect(Buffer.from(body.publicKey, 'base64')).toHaveLength(32)
  })

  it('serves the current key even when the database is unreachable', async () => {
    // It is served from memory, so a database outage does not stop a verifier from
    // checking a receipt it already holds.
    const offlineApp = createApp({ masterKey: TEST_MASTER_KEY,
      db: {
        async connect() {
          throw new Error('database is unreachable')
        },
      },
      signer,
      version: 'test',
      onError: () => {},
    })

    expect((await offlineApp.request('/v1/keys/current')).status).toBe(200)
  })

  // -------------------------------------------------------------------------
  // /v1/keys
  // -------------------------------------------------------------------------

  it('starts with no published keys and accumulates them', async () => {
    expect((await app.request('/v1/keys')).status).toBe(200)
    expect(((await (await app.request('/v1/keys')).json()) as { keys: unknown[] }).keys).toEqual([])

    await publishSigningKey(db.pool, signer)

    const afterFirst = (await (await app.request('/v1/keys')).json()) as {
      keys: { keyId: string; algorithm: string; publicKey: string; publishedAt: string }[]
    }

    expect(afterFirst.keys).toHaveLength(1)
    expect(afterFirst.keys[0]?.keyId).toBe(signer.keyId)
    expect(afterFirst.keys[0]?.algorithm).toBe('ed25519')
    expect(afterFirst.keys[0]?.publicKey).toBe(publicKeyBase64(signer))
    expect(Number.isNaN(Date.parse(afterFirst.keys[0]!.publishedAt))).toBe(false)
  })

  it('lists the full history, never dropping a rotated key', async () => {
    // A receipt names its key id, so removing an old key would make everything it signed
    // unverifiable. The app role is not even granted DELETE.
    const rotated = await signingKeyFromSeed(OTHER_SEED, 'k_0002')
    await publishSigningKey(db.pool, rotated)

    const body = (await (await app.request('/v1/keys')).json()) as { keys: { keyId: string }[] }
    const ids = body.keys.map((key) => key.keyId)

    expect(ids).toContain(signer.keyId)
    expect(ids).toContain('k_0002')
    expect(body.keys).toHaveLength(2)
  })

  it('orders keys oldest first', async () => {
    const body = (await (await app.request('/v1/keys')).json()) as { keys: { publishedAt: string }[] }

    const times = body.keys.map((key) => Date.parse(key.publishedAt))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('lists keys without authentication', async () => {
    // No X-API-Key: a third party holding a receipt must be able to fetch the key.
    const response = await app.request('/v1/keys')

    expect(response.status).toBe(200)
  })

  // -------------------------------------------------------------------------
  // Publication rules
  // -------------------------------------------------------------------------

  it('is idempotent when the same key is published again', async () => {
    const result = await publishSigningKey(db.pool, signer)

    expect(result).toBe('already-published')
    expect(await listPublishedKeys(db.pool)).toHaveLength(2)
  })

  it('refuses to reuse a key id for a different key', async () => {
    // Silently overwriting would break verification for every receipt already signed
    // under that id; leaving the old key would break every future one. Neither is
    // recoverable, so this is a hard stop.
    const impostor = await signingKeyFromSeed(OTHER_SEED, signer.keyId)

    await expect(publishSigningKey(db.pool, impostor)).rejects.toBeInstanceOf(SigningKeyConflictError)
    // And the published key is untouched.
    expect((await listPublishedKeys(db.pool)).find((key) => key.keyId === signer.keyId)?.publicKey).toBe(
      publicKeyBase64(signer),
    )
  })

  it('creates the first publication and reports it as created', async () => {
    const fresh = await signingKeyFromSeed(OTHER_SEED, 'k_0003')

    expect(await publishSigningKey(db.pool, fresh)).toBe('created')
    expect(await publishSigningKey(db.pool, fresh)).toBe('already-published')
  })
})
