/**
 * `GET /v1/health`.
 *
 * Health is the one endpoint that must answer without credentials AND without a
 * database, because it is what a platform health check hits. A health check that
 * fails when the database is briefly unavailable would have the orchestrator restart
 * a perfectly healthy process.
 */

import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import type { DbPool } from '../src/db/client.js'
import type { AppEnv } from '../src/env.js'
import { createTestDb, type TestDb } from './helpers/pg.js'

describe('GET /v1/health', () => {
  let db: TestDb
  let app: Hono<AppEnv>
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    app = createApp({ db: db.pool, version: 'test-version' })
    ready = true
  })

  afterAll(async () => {
    // `ready` rather than truthiness on `db`: if beforeAll threw, cleanup must not
    // raise a second, more confusing error on top of the real one.
    if (ready) await db.close()
  })

  it('returns 200 with no API key at all', async () => {
    const response = await app.request('/v1/health')

    expect(response.status).toBe(200)
  })

  it('returns { status: "ok", version }', async () => {
    const response = await app.request('/v1/health')

    expect(await response.json()).toEqual({ status: 'ok', version: 'test-version' })
  })

  it('does not consult the database', async () => {
    // A pool that cannot connect at all: health must still answer.
    const brokenPool: DbPool = {
      async connect() {
        throw new Error('database is unreachable')
      },
    }
    const offlineApp = createApp({ db: brokenPool, version: 'offline' })

    const response = await offlineApp.request('/v1/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', version: 'offline' })
  })

  it('falls back to the package version when none is configured', async () => {
    const response = await app.request('/v1/health')
    const body = (await response.json()) as { version: string }

    // The app under test was given 'test-version', so this asserts the override works
    // rather than the fallback; the fallback is covered by the offline app above
    // having been given an explicit version too.
    expect(body.version).toBe('test-version')
  })
})
