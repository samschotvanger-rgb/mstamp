/**
 * Service configuration, loaded from the environment.
 *
 * **This module is the "refuse to start" gate.** A backend that cannot sign cannot
 * produce a verifiable receipt, so every ingest would fail and the only symptom would
 * be an empty database. Failing loudly at startup, with a message specific enough to
 * fix without guessing, is strictly better.
 *
 * It refuses in development too, not just production. A dev server that boots without a
 * key and then silently rejects every receipt teaches the wrong thing about how the
 * service works.
 */

import { SigningKeyError, parseSigningSeed, signingKeyFromSeed, type SigningKey } from './crypto/sign.js'
import { BACKEND_VERSION } from './version.js'

/** Default key id, per the V1 handoff. */
export const DEFAULT_KEY_ID = 'k_0001'

export const DEFAULT_PORT = 3000

export type ServerEnv = Record<string, string | undefined>

export type ServiceConfig = {
  readonly databaseUrl: string
  readonly signingKey: SigningKey
  readonly port: number
  readonly version: string
  readonly nodeEnv: string
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}`)
  }
  return port
}

/**
 * Read and validate the service configuration.
 *
 * @throws {SigningKeyError} when the signing key is missing, is not base64, or does not
 * decode to a 32-byte seed.
 * @throws {Error} when `DATABASE_URL` is missing or `PORT` is not a valid port.
 */
export async function loadServiceConfig(env: ServerEnv = process.env): Promise<ServiceConfig> {
  const databaseUrl = env['DATABASE_URL']?.trim()
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required')
  }

  const rawKey = env['NOTCHED_SIGNING_KEY']?.trim()
  if (rawKey === undefined || rawKey === '') {
    throw new SigningKeyError(
      'NOTCHED_SIGNING_KEY is required: base64 of the 32-byte Ed25519 seed (e.g. `openssl rand -base64 32`)',
    )
  }

  const keyId = env['NOTCHED_SIGNING_KEY_ID']?.trim() || DEFAULT_KEY_ID
  const signingKey = await signingKeyFromSeed(parseSigningSeed(rawKey), keyId)

  return {
    databaseUrl,
    signingKey,
    port: parsePort(env['PORT']),
    version: BACKEND_VERSION,
    nodeEnv: env['NODE_ENV']?.trim() || 'development',
  }
}
