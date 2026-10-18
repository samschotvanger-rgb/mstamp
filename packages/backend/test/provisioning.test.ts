/**
 * First-run operations: tenant issuance, app-role provisioning, CLI guards.
 *
 * These cover the gap between "the tests pass" and "you can deploy it". Each of these
 * was previously done by hand, by SQL, against a live database.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { findTenantByApiKey, hashApiKey } from '../src/auth.js'
import { runIssueKey } from '../src/bin/issue-key.js'
import { runMigrations } from '../src/bin/migrate.js'
import { APP_ROLE, setAppRolePassword } from '../src/provision.js'
import { generateApiKey, issueTenantCredentials } from '../src/tenants.js'
import { createTestDb, type TestDb } from './helpers/pg.js'

const created: TestDb[] = []

async function openDb(): Promise<TestDb> {
  const db = await createTestDb()
  created.push(db)
  return db
}

afterEach(async () => {
  for (const db of created.splice(0)) await db.close()
})

describe('tenant issuance', () => {
  it('issues a key that actually authenticates', async () => {
    const db = await openDb()

    const { tenantId, apiKey } = await db.asOwner(() =>
      issueTenantCredentials(db.pool, { name: 'Acme Scrapers' }),
    )

    expect(tenantId).toMatch(/^tnt_[0-9A-Za-z_-]{21}$/)
    // 32 bytes base64url-encoded is 43 characters.
    expect(apiKey).toMatch(/^mstamp_sk_[A-Za-z0-9_-]{43}$/)

    const connection = await db.pool.connect()
    try {
      const tenant = await findTenantByApiKey(connection, apiKey)
      expect(tenant?.id).toBe(tenantId)
      expect(tenant?.name).toBe('Acme Scrapers')
      expect(tenant?.plan).toBe('free')
    } finally {
      connection.release?.()
    }
  })

  it('stores only the tagged hash, never the key', async () => {
    const db = await openDb()

    const { apiKey } = await db.asOwner(() =>
      issueTenantCredentials(db.pool, { name: 'Hash Check', plan: 'pro', spendLimitCents: 500 }),
    )

    const rows = await db.unscoped<{
      api_key_hash: string
      plan: string
      spend_limit_cents: number
    }>('SELECT api_key_hash, plan, spend_limit_cents FROM tenants WHERE name = $1', ['Hash Check'])

    // The tagged form matters: a bare hex hash would never match at lookup time.
    expect(rows[0]?.api_key_hash).toBe(hashApiKey(apiKey))
    expect(rows[0]?.api_key_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(rows[0]?.api_key_hash).not.toContain(apiKey)
    expect(rows[0]?.plan).toBe('pro')
    expect(rows[0]?.spend_limit_cents).toBe(500)
  })

  it('rejects a blank name', async () => {
    const db = await openDb()
    await expect(
      db.asOwner(() => issueTenantCredentials(db.pool, { name: '   ' })),
    ).rejects.toThrow(/needs a name/)
  })

  it('generates keys with no collisions', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()))
    expect(keys.size).toBe(100)
  })
})

describe('app role provisioning', () => {
  it('the app role can log in, which CREATE ROLE alone does not allow', async () => {
    const db = await openDb()

    // Migration 002 uses CREATE ROLE, which defaults to NOLOGIN. Migration 005 grants
    // LOGIN. Without it a real client cannot authenticate as mstamp_app at all, while
    // every SET ROLE-based isolation test still passes.
    const rows = await db.unscoped<{ rolcanlogin: boolean; rolsuper: boolean }>(
      'SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    )

    expect(rows[0]?.rolcanlogin).toBe(true)
    // And it must never become a superuser: superusers bypass RLS entirely.
    expect(rows[0]?.rolsuper).toBe(false)
  })

  it('sets a password containing a quote without breaking the statement', async () => {
    const db = await openDb()

    // A hand-escaped ALTER ROLE would fail or, worse, succeed with a truncated
    // password here. Postgres does the quoting via format('%L').
    await expect(
      db.asOwner(() => setAppRolePassword(db.pool, "s3cret-with-'quote")),
    ).resolves.toBeUndefined()
  })

  it('rejects an empty password', async () => {
    const db = await openDb()
    await expect(db.asOwner(() => setAppRolePassword(db.pool, ''))).rejects.toThrow(/must not be empty/)
  })
})

describe('CLI guards', () => {
  it('migrate refuses to run without MIGRATION_DATABASE_URL', async () => {
    await expect(runMigrations({})).rejects.toThrow(/MIGRATION_DATABASE_URL is required/)
  })

  it('issue-key refuses to run without a name', async () => {
    await expect(runIssueKey([], {})).rejects.toThrow(/--name is required/)
  })

  it('issue-key rejects a non-numeric spend limit', async () => {
    await expect(
      runIssueKey(['--name', 'X', '--spend-limit-cents', 'abc'], { MIGRATION_DATABASE_URL: 'postgres://x' }),
    ).rejects.toThrow(/non-negative integer/)
  })
})
