/**
 * Deployable entry point.
 *
 * Everything that can be validated before binding a port is validated before binding a
 * port. The order matters:
 *
 *   1. Load and validate configuration. A missing or malformed signing key throws here,
 *      so the process never reaches a state where it accepts ingest it cannot sign.
 *   2. Publish the public key. This happens *before* serving, so a receipt can never be
 *      signed with a key that verifiers cannot yet look up - which would produce
 *      receipts that are technically valid and practically unverifiable.
 *   3. Serve.
 */

import { pathToFileURL } from 'node:url'

import { serve } from '@hono/node-server'
import { Pool } from 'pg'

import { createApp } from './app.js'
import { loadServiceConfig, type ServerEnv } from './config.js'
import { poolFromPg } from './db/client.js'
import { publishSigningKey } from './db/keys.js'

export type RunningService = {
  readonly close: () => Promise<void>
}

/**
 * Start the service.
 *
 * @throws {SigningKeyError} when `NOTCHED_SIGNING_KEY` is missing or malformed.
 * @throws {SigningKeyConflictError} when the configured key id is already published
 * under a different public key.
 */
export async function startService(env: ServerEnv = process.env): Promise<RunningService> {
  const config = await loadServiceConfig(env)

  const pool = new Pool({ connectionString: config.databaseUrl })
  const db = poolFromPg(pool)

  try {
    await publishSigningKey(db, config.signingKey)
  } catch (error) {
    await pool.end()
    throw error
  }

  const app = createApp({ db, signer: config.signingKey, version: config.version })
  const server = serve({ fetch: app.fetch, port: config.port })

  return {
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      await pool.end()
    },
  }
}

const entry = process.argv[1]
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(entry).href

if (isDirectRun) {
  startService().catch((error: unknown) => {
    console.error('[notched] failed to start:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
