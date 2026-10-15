/**
 * Migration runner.
 *
 * Uses its own temp directories of SQL files rather than the real migrations, so the
 * runner's behaviour - ordering, idempotency, checksum enforcement, transactional
 * rollback - is tested against known inputs. The real migration set is exercised too,
 * since that is what actually has to work.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { queryRows, type DbConnection, type DbPool } from '../src/db/client.js'
import { MIGRATIONS_TABLE, defaultMigrationsDir, migrate } from '../src/db/migrate.js'
import { pglitePool } from './helpers/pg.js'

const TMP_ROOT = fileURLToPath(new URL('../.tmp', import.meta.url))

let dir: string

beforeEach(() => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(join(TMP_ROOT, 'migrations-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A bare Postgres pool with no role switching - migrations run as the owner. */
function barePool(): { pool: DbPool; connect: () => Promise<DbConnection>; close: () => Promise<void> } {
  const pglite = new PGlite()
  const pool = pglitePool(pglite)

  return { pool, connect: () => pool.connect(), close: () => pglite.close() }
}

describe('migrate', () => {
  it('applies the real migration set in order and records checksums', async () => {
    const db = barePool()
    try {
      const result = await migrate(db.pool)

      expect(result.applied).toEqual(['001_init.sql', '002_row_level_security.sql'])
      expect(result.alreadyApplied).toEqual([])

      const connection = await db.connect()
      const recorded = await queryRows<{ version: string; checksum: string }>(
        connection,
        `SELECT version, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`,
      )

      expect(recorded.map((row) => row.version)).toEqual(['001_init.sql', '002_row_level_security.sql'])
      for (const row of recorded) {
        expect(row.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
      }
    } finally {
      await db.close()
    }
  })

  it('is idempotent', async () => {
    const db = barePool()
    try {
      await migrate(db.pool)
      const second = await migrate(db.pool)

      expect(second.applied).toEqual([])
      expect(second.alreadyApplied).toEqual(['001_init.sql', '002_row_level_security.sql'])
    } finally {
      await db.close()
    }
  })

  it('applies files in filename order', async () => {
    // 002 inserts into the table 001 creates, so a reversed order fails outright.
    writeFileSync(join(dir, '001_create.sql'), 'CREATE TABLE widgets (id TEXT PRIMARY KEY)')
    writeFileSync(join(dir, '002_insert.sql'), `INSERT INTO widgets (id) VALUES ('w1')`)

    const db = barePool()
    try {
      const result = await migrate(db.pool, { dir })
      expect(result.applied).toEqual(['001_create.sql', '002_insert.sql'])

      const connection = await db.connect()
      const rows = await queryRows<{ id: string }>(connection, 'SELECT id FROM widgets')
      expect(rows).toEqual([{ id: 'w1' }])
    } finally {
      await db.close()
    }
  })

  it('refuses to run when an applied migration has been edited', async () => {
    // The deployed database would never see the edit, so it would silently diverge
    // from a freshly-migrated one. Refusing is the only safe answer.
    const file = join(dir, '001_thing.sql')
    writeFileSync(file, 'CREATE TABLE thing (id TEXT)')

    const db = barePool()
    try {
      await migrate(db.pool, { dir })

      writeFileSync(file, 'CREATE TABLE thing (id TEXT, extra TEXT)')

      await expect(migrate(db.pool, { dir })).rejects.toThrow(/append-only|contents changed/)
    } finally {
      await db.close()
    }
  })

  it('rolls a failing migration back completely', async () => {
    writeFileSync(join(dir, '001_good.sql'), 'CREATE TABLE keeps (id TEXT)')
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE partial (id TEXT); SELECT this_is_not_valid_sql;')

    const db = barePool()
    try {
      await expect(migrate(db.pool, { dir })).rejects.toThrow(/002_bad\.sql failed/)

      const connection = await db.connect()

      // Postgres has transactional DDL: the good migration persisted...
      const tables = await queryRows<{ tablename: string }>(
        connection,
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
      expect(tables.map((row) => row.tablename)).toContain('keeps')

      // ...the failing one left nothing behind, not even its first statement...
      expect(tables.map((row) => row.tablename)).not.toContain('partial')

      // ...and there is no record of it having run.
      const recorded = await queryRows<{ version: string }>(
        connection,
        `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`,
      )
      expect(recorded.map((row) => row.version)).toEqual(['001_good.sql'])
    } finally {
      await db.close()
    }
  })

  it('resolves the default migrations directory to the package\'s migrations folder', () => {
    expect(defaultMigrationsDir()).toMatch(/packages[\\/]backend[\\/]migrations$/)
  })
})
