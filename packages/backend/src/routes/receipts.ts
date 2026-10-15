import { Hono, type Handler } from 'hono'

import { verifyReceipt } from '../crypto/sign.js'
import { withTenant, type DbPool } from '../db/client.js'
import { findPublishedKey } from '../db/keys.js'
import { selectReceipt, selectReceiptForVerification } from '../db/receipts.js'
import type { AppEnv } from '../env.js'

export type ReceiptRoutesConfig = {
  readonly pool: DbPool
}

/**
 * `GET /v1/receipts/:id` - authenticated, tenant-scoped.
 *
 * The query deliberately has **no `WHERE tenant_id = ...` clause**. Row-level security
 * decides what this tenant can see, and duplicating the filter in application code would
 * hide an RLS bug: the query would look correct while the policy was broken, and the
 * duplicate would have to be kept in sync forever. The tenant comes from the API key via
 * the middleware and is applied by `withTenant` as a transaction-local setting.
 */
export function receiptsRoutes(config: ReceiptRoutesConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/:id', async (c) => {
    const tenant = c.get('tenant')
    const receiptId = c.req.param('id') ?? ''

    const receipt = await withTenant(config.pool, tenant.id, (tx) => selectReceipt(tx, receiptId))

    // 404, not 403, for a receipt that exists but belongs to someone else. A 403 would
    // confirm the id exists, turning this into an existence oracle over other tenants'
    // receipt ids - and receipt ids are long enough to be unguessable, so the only thing
    // an oracle would leak is which guesses were right.
    if (receipt === null) {
      return c.json({ error: 'receipt_not_found' }, 404)
    }

    return c.json(receipt)
  })

  return routes
}

/**
 * `GET /v1/receipts/:id/verify` - public, no auth.
 *
 * Returns `{ valid, receiptId, signedAt, attestation, keyId }` and **never the receipt
 * contents**. A verifier who already holds the receipt can confirm it is authentic; someone
 * who only guessed an id learns nothing beyond the metadata.
 *
 * A failed verification is a successful response: `200` with `valid: false`. Only a missing
 * receipt is a 404. Nothing in here throws - a corrupted stored receipt, an unknown key id,
 * or an unreadable payload all resolve to `valid: false`, because a verifier that errors on
 * hostile input is a denial-of-service surface.
 */
export function verifyReceiptHandler(config: ReceiptRoutesConfig): Handler<AppEnv> {
  return async (c) => {
    const receiptId = c.req.param('id') ?? ''

    // Crosses tenants by necessity - there are no credentials to scope it by - via a
    // SECURITY DEFINER function. See the note on `selectReceiptForVerification`.
    const receipt = await selectReceiptForVerification(config.pool, receiptId)

    if (receipt === null) {
      return c.json({ error: 'receipt_not_found' }, 404)
    }

    let valid = false
    try {
      const published = receipt.keyId === null ? null : await findPublishedKey(config.pool, receipt.keyId)
      if (published !== null) {
        valid = await verifyReceipt(receipt, published.publicKey)
      }
    } catch {
      // Could not resolve a key, could not canonicalise, signature malformed: all of these
      // mean "not valid", and none of them are an error the caller can act on.
      valid = false
    }

    return c.json({
      valid,
      receiptId: receipt.receiptId,
      signedAt: receipt.signedAt,
      attestation: receipt.attestation,
      keyId: receipt.keyId,
    })
  }
}
