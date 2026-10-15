/**
 * Row-level tenant isolation.
 *
 * These tests are only meaningful because the harness switches to the `notched_app`
 * role after migrating. A table owner and a superuser both bypass RLS entirely, so
 * running these assertions as the migration user would pass no matter what the policy
 * said - which is the classic way an RLS test ends up proving nothing.
 *
 * The required test - "Tenant A's key cannot read Tenant B's rows" - goes through the
 * real path: API key -> middleware -> resolved tenant -> tenant-scoped query. Not a
 * hardcoded tenant id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { API_KEY_HEADER } from '../src/auth.js'
import { currentTenantSetting, queryRows, withConnection, withTenant } from '../src/db/client.js'
import { createTestDb, seedReceipt, seedTenant, type TestDb } from './helpers/pg.js'

const KEY_A = 'sk_test_rls_tenant_a'
const KEY_B = 'sk_test_rls_tenant_b'

/** Minimal valid insert, parameterised on tenant so a mismatch can be forced. */
const INSERT_RECEIPT = `
  INSERT INTO receipts (
    id, tenant_id, provider, operation, request_hash, response_hash,
    status_code, latency_ms, timestamp, registration, attestation,
    validation, sdk_version, schema_version
  ) VALUES ($1, $2, 'scraper-x', 'extract', $3, $4, 200, 1, now(), 'hash-only', 'self', '{}'::jsonb, '0.1.0', '1')
`

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`

describe('row-level tenant isolation', () => {
  let db: TestDb
  let app: ReturnType<typeof createApp>
  let ready = false

  beforeAll(async () => {
    db = await createTestDb()
    await seedTenant(db, { id: 'tnt_a', apiKey: KEY_A, name: 'Tenant A' })
    await seedTenant(db, { id: 'tnt_b', apiKey: KEY_B, name: 'Tenant B' })

    await seedReceipt(db, { id: 'rcpt_a1', tenantId: 'tnt_a' })
    await seedReceipt(db, { id: 'rcpt_a2', tenantId: 'tnt_a' })
    await seedReceipt(db, { id: 'rcpt_b1', tenantId: 'tnt_b' })

    app = createApp({ db: db.pool, version: 'test', onError: () => {} })
    ready = true
  })

  afterAll(async () => {
    if (ready) await db.close()
  })

  // -------------------------------------------------------------------------
  // Required
  // -------------------------------------------------------------------------

  it('prevents tenant A from reading tenant B\'s rows', async () => {
    // Resolve the tenant the way a real request does: through the API key.
    const whoami = await app.request('/v1/whoami', { headers: { [API_KEY_HEADER]: KEY_A } })
    const { tenantId } = (await whoami.json()) as { tenantId: string }
    expect(tenantId).toBe('tnt_a')

    const visible = await withTenant(db.pool, tenantId, (tx) =>
      queryRows<{ id: string }>(tx, 'SELECT id FROM receipts ORDER BY id'),
    )

    expect(visible.map((row) => row.id)).toEqual(['rcpt_a1', 'rcpt_a2'])
    expect(visible.map((row) => row.id)).not.toContain('rcpt_b1')

    // The row really is there - it is the policy hiding it, not a missing insert.
    const everything = await db.asOwner(() =>
      db.unscoped<{ n: number }>('SELECT count(*)::int AS n FROM receipts'),
    )
    expect(everything[0]?.n).toBe(3)
  })

  it('shows tenant B only its own rows', async () => {
    const visible = await withTenant(db.pool, 'tnt_b', (tx) =>
      queryRows<{ id: string }>(tx, 'SELECT id FROM receipts ORDER BY id'),
    )

    expect(visible.map((row) => row.id)).toEqual(['rcpt_b1'])
  })

  it('returns no rows at all when no tenant is set, rather than every row', async () => {
    // Fail-closed. `current_setting('app.tenant_id', true)` is NULL, the policy
    // comparison is NULL, and NULL is not true - so nothing matches.
    const rows = await db.unscoped<{ id: string }>('SELECT id FROM receipts')

    expect(rows).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  it('refuses a cross-tenant INSERT', async () => {
    // USING filters reads; only WITH CHECK stops a write that claims another tenant.
    await expect(
      withTenant(db.pool, 'tnt_a', (tx) => tx.query(INSERT_RECEIPT, ['rcpt_forged', 'tnt_b', HASH_A, HASH_B])),
    ).rejects.toThrow(/row-level security/i)

    const everything = await db.asOwner(() =>
      db.unscoped<{ n: number }>('SELECT count(*)::int AS n FROM receipts'),
    )
    expect(everything[0]?.n).toBe(3)
  })

  it('allows a tenant to insert its own rows', async () => {
    await withTenant(db.pool, 'tnt_a', (tx) => tx.query(INSERT_RECEIPT, ['rcpt_a3', 'tnt_a', HASH_A, HASH_B]))

    const visible = await withTenant(db.pool, 'tnt_a', (tx) =>
      queryRows<{ id: string }>(tx, `SELECT id FROM receipts WHERE id = 'rcpt_a3'`),
    )
    expect(visible).toHaveLength(1)
  })

  it('isolates the payloads table as well', async () => {
    await withTenant(db.pool, 'tnt_a', (tx) =>
      tx.query(
        `INSERT INTO payloads (receipt_id, tenant_id, encrypted, expires_at)
         VALUES ('rcpt_a1', 'tnt_a', $1, now() + interval '7 days')`,
        [Buffer.from([1, 2, 3])],
      ),
    )

    const asA = await withTenant(db.pool, 'tnt_a', (tx) => queryRows(tx, 'SELECT receipt_id FROM payloads'))
    const asB = await withTenant(db.pool, 'tnt_b', (tx) => queryRows(tx, 'SELECT receipt_id FROM payloads'))

    expect(asA).toHaveLength(1)
    expect(asB).toEqual([])

    await expect(
      withTenant(db.pool, 'tnt_a', (tx) =>
        tx.query(
          `INSERT INTO payloads (receipt_id, tenant_id, encrypted, expires_at)
           VALUES ('rcpt_b1', 'tnt_b', $1, now() + interval '7 days')`,
          [Buffer.from([4])],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  // -------------------------------------------------------------------------
  // SET LOCAL, not SET
  // -------------------------------------------------------------------------

  it('does not leak the tenant setting beyond its transaction', async () => {
    // This is the test that distinguishes SET LOCAL from SET. A session-scoped SET
    // would still read back as 'tnt_a' here, and on a pooled connection the next
    // request would inherit tenant A's scope - the exact bug the helper exists to
    // prevent.
    await withTenant(db.pool, 'tnt_a', (tx) => queryRows(tx, 'SELECT 1'))

    const leaked = await withConnection(db.pool, (connection) => currentTenantSetting(connection))

    expect(leaked === null || leaked === '').toBe(true)
  })

  it('scopes each transaction independently', async () => {
    const first = await withTenant(db.pool, 'tnt_a', (tx) => currentTenantSetting(tx))
    const second = await withTenant(db.pool, 'tnt_b', (tx) => currentTenantSetting(tx))

    expect(first).toBe('tnt_a')
    expect(second).toBe('tnt_b')
  })

  // -------------------------------------------------------------------------
  // The safety machinery itself
  // -------------------------------------------------------------------------

  it('has row-level security enabled and a policy on both tables', async () => {
    const tables = await db.unscoped<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('receipts', 'payloads') ORDER BY relname`,
    )

    expect(tables).toEqual([
      { relname: 'payloads', relrowsecurity: true },
      { relname: 'receipts', relrowsecurity: true },
    ])

    const policies = await db.unscoped<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
       WHERE schemaname = 'public' ORDER BY tablename`,
    )

    expect(policies).toEqual([
      { tablename: 'payloads', policyname: 'tenant_isolation' },
      { tablename: 'receipts', policyname: 'tenant_isolation' },
    ])
  })

  it('leaves the tenants table unscoped, so a key can be resolved at all', async () => {
    // Deliberate: the middleware must find a tenant before any tenant is known.
    const rows = await db.unscoped<{ n: number }>('SELECT count(*)::int AS n FROM tenants')

    expect(rows[0]?.n).toBe(2)
  })

  it('refuses an empty tenant id rather than silently scoping to nothing', async () => {
    await expect(withTenant(db.pool, '', (tx) => queryRows(tx, 'SELECT 1'))).rejects.toThrow(/non-empty tenant id/)
  })

  it('rolls the whole transaction back when the body throws', async () => {
    await expect(
      withTenant(db.pool, 'tnt_a', async (tx) => {
        await tx.query(INSERT_RECEIPT, ['rcpt_rolled_back', 'tnt_a', HASH_A, HASH_B])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const everything = await db.asOwner(() =>
      db.unscoped<{ id: string }>(`SELECT id FROM receipts WHERE id = 'rcpt_rolled_back'`),
    )
    expect(everything).toEqual([])
  })

  it('applies the app role, which is what makes RLS bite', async () => {
    const current = await db.unscoped<{ current_user: string }>('SELECT current_user')
    const attributes = await db.unscoped<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    )

    expect(current[0]?.current_user).toBe('notched_app')
    // If either of these were true, every assertion above would pass vacuously.
    expect(attributes[0]?.rolsuper).toBe(false)
    expect(attributes[0]?.rolbypassrls).toBe(false)
  })
})
