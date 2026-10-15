/**
 * API key middleware.
 *
 * The middleware is the only thing standing between an unauthenticated request and
 * tenant data, so the tests cover every way a request can fail to prove who it is:
 * no header, an empty header, an unknown key, and a key that resolves to a different
 * tenant than expected.
 *
 * `/v1/whoami` is the protected route used here. It is not a V1 endpoint; it exists so
 * "some other route" is a real thing to test against, and so the resolved tenant is
 * observable at all in Week 3a.
 */

import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { API_KEY_HEADER } from '../src/auth.js'
import type { AppEnv } from '../src/env.js'
import { createTestDb, seedTenant, type TestDb } from './helpers/pg.js'

const KEY_A = 'sk_test_tenant_a_0000000000000000'
const KEY_B = 'sk_test_tenant_b_1111111111111111'

describe('API key authentication', () => {
  let db: TestDb
  let app: Hono<AppEnv>
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    await seedTenant(db, { id: 'tnt_a', apiKey: KEY_A, name: 'Tenant A', plan: 'pro', spendLimitCents: 5000 })
    await seedTenant(db, { id: 'tnt_b', apiKey: KEY_B, name: 'Tenant B' })
    app = createApp({ db: db.pool, version: 'test', onError: () => {} })
    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  // -------------------------------------------------------------------------
  // Required: no key on any other route
  // -------------------------------------------------------------------------

  it('rejects a protected route with no key', async () => {
    const response = await app.request('/v1/whoami')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'missing_api_key' })
  })

  it('rejects an empty key', async () => {
    const response = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: '' } })

    expect(response.status).toBe(401)
  })

  it('rejects an unknown key', async () => {
    const response = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: 'sk_test_not_a_real_key' } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid_api_key' })
  })

  it('leaves health public', async () => {
    expect((await app.request('/v1/health')).status).toBe(200)
  })

  it('rejects an unknown path rather than falling through to a handler', async () => {
    const response = await app.request('/v1/does-not-exist')

    // No key, so auth answers first - a 404 here would leak which routes exist.
    expect(response.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Required: a valid key resolves the correct tenant
  // -------------------------------------------------------------------------

  it('accepts a valid key and resolves its tenant', async () => {
    const response = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: KEY_A } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tenantId: 'tnt_a',
      name: 'Tenant A',
      plan: 'pro',
      spendLimitCents: 5000,
    })
  })

  it('resolves the RIGHT tenant when several keys exist', async () => {
    // The failure this guards against is a lookup that ignores the key and returns
    // whichever tenant it finds first.
    const a = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: KEY_A } })
    const b = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: KEY_B } })

    expect(((await a.json()) as { tenantId: string }).tenantId).toBe('tnt_a')
    expect(((await b.json()) as { tenantId: string }).tenantId).toBe('tnt_b')
  })

  it('is case-insensitive about the header name, as HTTP requires', async () => {
    const response = await app.request('/v1/whoami', { headers: { 'x-api-key': KEY_A } })

    expect(response.status).toBe(200)
  })

  it('does not accept a key that merely resembles a real one', async () => {
    for (const candidate of [
      KEY_A.slice(0, -1), // truncated
      `${KEY_A}x`, // one character too many
      KEY_A.toUpperCase(), // wrong case
      KEY_A.replace('tenant_a', 'tenant_b'), // a different, also-unknown key
    ]) {
      const response = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: candidate } })
      expect(response.status, `candidate ${JSON.stringify(candidate)}`).toBe(401)
    }
  })

  it('treats leading and trailing whitespace the way HTTP itself does', async () => {
    // HTTP strips optional whitespace (OWS) from a header field value, so `' key '`
    // arrives at the app as `'key'`. There is nothing to disambiguate, and padding
    // cannot be used to make a lookup miss - which is why the resemblance cases above
    // are about content, not whitespace.
    const padded = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: ` ${KEY_A} ` } })

    expect(padded.status).toBe(200)
  })

  it('answers 500, not 401, when the database is unreachable', async () => {
    // Collapsing this into 401 would tell a caller with a perfectly good key that their
    // key is bad, sending them off to rotate credentials during an outage.
    const offlineApp = createApp({
      db: {
        async connect() {
          throw new Error('database is unreachable')
        },
      },
      onError: () => {},
    })

    const response = await offlineApp.request('/v1/whoami', { headers: { [API_KEY_HEADER]: KEY_A } })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal_error' })
  })

  it('does not leak the key hash or the key itself in any response', async () => {
    const ok = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: KEY_A } })
    const denied = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: 'sk_wrong' } })

    expect(await ok.text()).not.toContain(KEY_A)
    expect(await denied.text()).not.toContain('sk_wrong')
  })
})
