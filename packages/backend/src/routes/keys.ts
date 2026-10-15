import { Hono } from 'hono'

import { SIGNATURE_ALGORITHM, publicKeyBase64, type SigningKey } from '../crypto/sign.js'
import type { DbPool } from '../db/client.js'
import { listPublishedKeys } from '../db/keys.js'
import type { AppEnv } from '../env.js'

export type KeysRoutesConfig = {
  readonly signer: SigningKey
  readonly pool: DbPool
}

/**
 * `GET /v1/keys` and `GET /v1/keys/current` - both public, no auth.
 *
 * Publishing keys without authentication is intentional: a verifier holds a receipt and
 * a public key, and nothing else. Requiring a credential to fetch the key would make
 * offline verification impossible for exactly the third parties the receipt is meant to
 * convince.
 */
export function keysRoutes(config: KeysRoutesConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  /**
   * The key the server is signing with right now.
   *
   * Served from memory rather than the database. This answers "what do I check a fresh
   * receipt against", and it must not depend on a database round trip - if the database
   * is down, receipts already signed are still verifiable.
   */
  routes.get('/current', (c) =>
    c.json({
      keyId: config.signer.keyId,
      algorithm: SIGNATURE_ALGORITHM,
      publicKey: publicKeyBase64(config.signer),
    }),
  )

  /**
   * Every key ever published, oldest first.
   *
   * Never filtered and never pruned. A receipt names its key in `keyId`, so a verifier
   * needs the whole history - dropping a rotated key would make everything it signed
   * unverifiable.
   */
  routes.get('/', async (c) => c.json({ keys: await listPublishedKeys(config.pool) }))

  return routes
}
