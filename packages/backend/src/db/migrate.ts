/**
 * Migration runner.
 *
 * Numbered `.sql` files, applied in filename order, each in its own transaction.
 * No ORM: the schema is the SQL, reviewable in a diff.
 *
 * Two properties worth the code they cost:
 *
 *   - **Applied migrations are checksummed.** Editing a migration that has already
 *     run is almost always a mistake - the deployed database will never see the
 *     change, so it silently diverges from a fresh one. The runner refuses instead
 *     of pretending. Migrations are append-only: add a new numbered file.
 *
 *   - **One transaction per migration.** Postgres has transactional DDL, so a
 *     failing migration leaves neither partial schema nor a record of having run.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256Hex } from '@notched/protocol'

import { queryRows, withConnection, type DbConnection, type DbPool } from './client.js'

/** Bookkeeping table. Never dropped; it is the record of what has run. */
export const MIGRATIONS_TABLE = 'schema_migrations'

export type MigrateOptions = {
  /** Directory of numbered `.sql` files. Defaults to `packages/backend/migrations`. */
  dir?: string
}

export type MigrateResult = {
  /** Filenames applied by THIS run, in order. */
  applied: string[]
  /** Filenames already applied and verified unchanged. */
  alreadyApplied: string[]
}

/**
 * `packages/backend/migrations`.
 *
 * Resolved as `../../migrations` from this module, which lands on the same
 * directory whether it runs from `src/db/` or `dist/db/` - so the SQL never needs
 * copying into the build output.
 */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url))
}

const ENCODER = new TextEncoder()

function checksumOf(sql: string): string {
  return `sha256:${sha256Hex(ENCODER.encode(sql))}`
}

async function ensureMigrationsTable(connection: DbConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Apply every pending migration.
 *
 * Idempotent: running it twice applies nothing the second time.
 *
 * @throws if a previously-applied migration's contents have changed, or if any
 * migration fails. A failure rolls that migration back and stops the run.
 */
export async function migrate(pool: DbPool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? defaultMigrationsDir()

  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()

  return withConnection(pool, async (connection) => {
    await ensureMigrationsTable(connection)

    const recorded = await queryRows<{ version: string; checksum: string }>(
      connection,
      `SELECT version, checksum FROM ${MIGRATIONS_TABLE}`,
    )
    const appliedChecksums = new Map(recorded.map((row) => [row.version, row.checksum]))

    const applied: string[] = []
    const alreadyApplied: string[] = []

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8')
      const checksum = checksumOf(sql)
      const previous = appliedChecksums.get(file)

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `migration ${file} has already been applied but its contents changed ` +
              `(recorded ${previous}, found ${checksum}). Migrations are append-only: ` +
              `add a new numbered file instead of editing an applied one.`,
          )
        }
        alreadyApplied.push(file)
        continue
      }

      await connection.query('BEGIN')
      try {
        // No bind parameters, so the whole file runs as a simple query and may
        // contain multiple statements.
        await connection.query(sql)
        await connection.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, checksum) VALUES ($1, $2)`, [
          file,
          checksum,
        ])
        await connection.query('COMMIT')
      } catch (error) {
        try {
          await connection.query('ROLLBACK')
        } catch {
          // Already unwound.
        }
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`migration ${file} failed: ${detail}`, { cause: error })
      }

      applied.push(file)
    }

    return { applied, alreadyApplied }
  })
}
