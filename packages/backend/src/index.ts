/**
 * `@notched/backend` - the Notched service.
 *
 * Week 3b: Ed25519 signing, `POST /v1/ingest/batch`, and the published key endpoints.
 * `/v1/receipts`, `/v1/verify`, payload encryption and the purge job are still to come.
 */

export * from './env.js'
export * from './app.js'
export * from './auth.js'
export * from './config.js'
export * from './serve.js'
export * from './version.js'
export * from './crypto/sign.js'
export * from './db/client.js'
export * from './db/keys.js'
export * from './db/migrate.js'
export * from './db/receipts.js'
export * from './routes/health.js'
export * from './routes/ingest.js'
export * from './routes/keys.js'
export * from './routes/whoami.js'
