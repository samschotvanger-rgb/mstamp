/**
 * The payload retention job.
 *
 * The interesting test here is the cross-tenant one. Row-level security is enabled on
 * `payloads`, so a `DELETE ... WHERE expires_at < now()` run as the application role with
 * no `app.tenant_id` set matches **zero rows** - the job would report success and retain
 * everything, which is the worst possible failure for a retention guarantee. The job goes
 * through a `SECURITY DEFINER` function for exactly that reason, and the test proves it by
 * expiring payloads for two different tenants at once.
 *
 * The other thing worth asserting is what the job does NOT touch: receipts. Previews are a
 * seven-day debugging convenience; receipts are the evidence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '../src/db/client.js'
import { insertEncryptedPayload } from '../src/db/payloads.js'
import { purgeExpiredPayloads } from '../src/purge.js'
import { createTestDb, seedReceipt, seedTenant, type TestDb } from './helpers/pg.js'

describe('purgeExpiredPayloads', () => {
  let db: TestDb
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    await seedTenant(db, { id: 'tnt_a', apiKey: 'sk_purge_a', name: 'Tenant A' })
    await seedTenant(db, { id: 'tnt_b', apiKey: 'sk_purge_b', name: 'Tenant B' })
    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  /** Create a receipt and attach an encrypted payload that expires in `retentionDays`. */
  async function addPayload(receiptId: string, tenantId: string, retentionDays: number): Promise<void> {
    await seedReceipt(db, { id: receiptId, tenantId })
    await withTenant(db.pool, tenantId, (tx) =>
      insertEncryptedPayload(tx, {
        receiptId,
        tenantId,
        encrypted: new Uint8Array([1, 2, 3, 4]),
        retentionDays,
      }),
    )
  }

  async function payloadIds(): Promise<string[]> {
    const rows = await db.asOwner(() =>
      db.unscoped<{ receipt_id: string }>('SELECT receipt_id FROM payloads ORDER BY receipt_id'),
    )
    return rows.map((row) => row.receipt_id)
  }

  async function receiptIds(): Promise<string[]> {
    const rows = await db.asOwner(() =>
      db.unscoped<{ id: string }>('SELECT id FROM receipts ORDER BY id'),
    )
    return rows.map((row) => row.id)
  }

  // -------------------------------------------------------------------------
  // Required: expired goes, live stays
  // -------------------------------------------------------------------------

  it('deletes an expired payload and keeps a live one', async () => {
    await addPayload('rcpt_expired', 'tnt_a', -1)
    await addPayload('rcpt_live', 'tnt_a', 7)

    const result = await purgeExpiredPayloads(db.pool)

    expect(result.deleted).toBe(1)
    expect(await payloadIds()).toEqual(['rcpt_live'])
  })

  // -------------------------------------------------------------------------
  // Required: receipts are never purged
  // -------------------------------------------------------------------------

  it('never touches receipts', async () => {
    // Both receipts still exist even though one of them just lost its payload.
    expect(await receiptIds()).toEqual(['rcpt_expired', 'rcpt_live'])
  })

  it('leaves receipts alone across a purge that deletes many payloads', async () => {
    await addPayload('rcpt_more_expired', 'tnt_a', -2)
    await addPayload('rcpt_also_live', 'tnt_a', 30)

    const before = await receiptIds()
    await purgeExpiredPayloads(db.pool)
    const after = await receiptIds()

    expect(after).toEqual(before)
    expect(after).toContain('rcpt_more_expired')
  })

  // -------------------------------------------------------------------------
  // Cross-tenant: the reason it needs definer rights
  // -------------------------------------------------------------------------

  it('reaches expired payloads belonging to every tenant', async () => {
    await addPayload('rcpt_a_expired', 'tnt_a', -1)
    await addPayload('rcpt_b_expired', 'tnt_b', -1)
    await addPayload('rcpt_b_live', 'tnt_b', 7)

    const result = await purgeExpiredPayloads(db.pool)

    // Both tenants' expired rows go. With a plain DELETE as the app role this would be 0,
    // and the job would look successful while retaining everything.
    expect(result.deleted).toBe(2)
    expect(await payloadIds()).toEqual(['rcpt_also_live', 'rcpt_b_live', 'rcpt_live'])
  })

  it('runs with no tenant context at all', async () => {
    // It is called on a plain connection by a scheduler, which has no tenant to set.
    const result = await purgeExpiredPayloads(db.pool)

    expect(result).toEqual({ deleted: 0 })
  })

  // -------------------------------------------------------------------------
  // Shape
  // -------------------------------------------------------------------------

  it('reports how many rows it deleted', async () => {
    await addPayload('rcpt_count_1', 'tnt_a', -1)
    await addPayload('rcpt_count_2', 'tnt_a', -1)
    await addPayload('rcpt_count_3', 'tnt_a', -1)

    expect(await purgeExpiredPayloads(db.pool)).toEqual({ deleted: 3 })
  })

  it('is a no-op when nothing has expired', async () => {
    const first = await purgeExpiredPayloads(db.pool)
    const second = await purgeExpiredPayloads(db.pool)

    expect(first).toEqual({ deleted: 0 })
    expect(second).toEqual({ deleted: 0 })
  })

  it('is safe to run against an empty payloads table', async () => {
    await db.asOwner(() => db.unscoped('DELETE FROM payloads'))

    expect(await purgeExpiredPayloads(db.pool)).toEqual({ deleted: 0 })
  })

  it('treats a payload expiring exactly now as deletable', async () => {
    await addPayload('rcpt_boundary', 'tnt_a', 0)

    // `expires_at < now()` is evaluated in Postgres; a zero-day retention is already past
    // by the time the purge runs, since the insert happened first.
    expect((await purgeExpiredPayloads(db.pool)).deleted).toBe(1)
  })
})
