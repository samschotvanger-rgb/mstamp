/**
 * The Hono app.
 *
 * Route registration order is security-relevant, so it is deliberate and commented: a
 * handler that returns without calling `next()` ends the chain, so anything registered
 * before the auth middleware is public. Public: `/v1/health`, `/v1/keys` and
 * `/v1/keys/current`. Everything else under `/v1` requires an API key.
 *
 * Week 3b implements signing, ingest and the key endpoints. `/v1/receipts` and
 * `/v1/verify` are 3c; encryption and the purge job are still to come.
 */

import { Hono } from 'hono'

import { apiKeyAuth } from './auth.js'
import type { SigningKey } from './crypto/sign.js'
import type { DbPool } from './db/client.js'
import type { AppEnv } from './env.js'
import { healthRoutes } from './routes/health.js'
import { ingestRoutes } from './routes/ingest.js'
import { keysRoutes } from './routes/keys.js'
import { whoamiRoutes } from './routes/whoami.js'
import { BACKEND_VERSION } from './version.js'

export type AppConfig = {
  db: DbPool
  /** The key receipts are signed with. Required - an unsigned backend is not a backend. */
  signer: SigningKey
  /** Overrides the version read from `package.json`. Tests use this. */
  version?: string
  /**
   * Receives unhandled errors before a 500 is returned. Defaults to `console.error`.
   *
   * Overridable so tests can assert on failures without noise, and so a deployer can
   * route errors into their own logging.
   */
  onError?: (error: unknown) => void
  /** Injected clock, so `signedAt` is deterministic in tests. */
  now?: () => number
}

export function createApp(config: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const reportError =
    config.onError ??
    ((error: unknown): void => {
      console.error('[notched] unhandled error', error)
    })

  // 1. Public routes FIRST - health and the published keys. A verifier needs the public
  //    keys before it has any credentials, which is the whole point of publishing them.
  app.route('/v1/health', healthRoutes(config.version ?? BACKEND_VERSION))
  app.route('/v1/keys', keysRoutes({ signer: config.signer, pool: config.db }))

  // 2. Everything else under /v1 requires a key. Registered after the public routes.
  app.use('/v1/*', apiKeyAuth(config.db))

  // 3. Authenticated routes.
  app.route('/v1/whoami', whoamiRoutes())
  app.route(
    '/v1/ingest',
    ingestRoutes({
      pool: config.db,
      signer: config.signer,
      onError: reportError,
      ...(config.now === undefined ? {} : { now: config.now }),
    }),
  )

  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  // A database outage makes the auth middleware throw. That must not surface as a
  // stack trace, and it must not be mistaken for a 401 - the caller's key may well be
  // fine, we simply could not check it.
  app.onError((error, c) => {
    reportError(error)
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
