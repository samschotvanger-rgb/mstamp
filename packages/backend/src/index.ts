/**
 * `@notched/backend` - the Notched service.
 *
 * Week 3a: the Hono app, the Postgres schema, row-level tenant isolation, and API key
 * authentication. Signing, ingest, `/v1/keys`, `/v1/receipts` and `/v1/verify` are
 * deliberately absent - they are 3b and 3c.
 */

export * from './env.js'
export * from './app.js'
export * from './auth.js'
export * from './version.js'
export * from './db/client.js'
export * from './db/migrate.js'
export * from './routes/health.js'
export * from './routes/whoami.js'
