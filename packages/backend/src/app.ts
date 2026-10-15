/**
 * The Hono app.
 *
 * Route registration order is security-relevant here, so it is deliberate and
 * commented: `/v1/health` is registered before the auth middleware, and its handler
 * returns without calling `next()`, so the middleware never runs for it. Everything
 * else under `/v1` is behind `apiKeyAuth`.
 *
 * Week 3a implements health and the API key middleware only. Ingest, signing,
 * `/v1/keys`, `/v1/receipts` and `/v1/verify` are 3b and 3c.
 */

import { Hono } from 'hono'

import { apiKeyAuth } from './auth.js'
import type { DbPool } from './db/client.js'
import type { AppEnv } from './env.js'
import { healthRoutes } from './routes/health.js'
import { whoamiRoutes } from './routes/whoami.js'
import { BACKEND_VERSION } from './version.js'

export type AppConfig = {
  db: DbPool
  /** Overrides the version read from `package.json`. Tests use this. */
  version?: string
  /**
   * Receives unhandled errors before a 500 is returned. Defaults to `console.error`.
   *
   * Overridable so tests can assert on failures without noise, and so a deployer can
   * route errors into their own logging.
   */
  onError?: (error: unknown) => void
}

export function createApp(config: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const reportError =
    config.onError ??
    ((error: unknown): void => {
      console.error('[notched] unhandled error', error)
    })

  // 1. Public routes FIRST. A handler that returns without `next()` ends the chain,
  //    so the auth middleware registered below never runs for these.
  app.route('/v1/health', healthRoutes(config.version ?? BACKEND_VERSION))

  // 2. Everything else under /v1 requires a key. Registered after health on purpose.
  app.use('/v1/*', apiKeyAuth(config.db))

  // 3. Authenticated routes.
  app.route('/v1/whoami', whoamiRoutes())

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
