/**
 * Shared plumbing for the operational CLIs: `migrate`, `issue-key`, `purge`.
 *
 * These are release and maintenance steps, so they fail loudly and set a non-zero exit
 * code. They are also importable, so the logic behind each one is testable without
 * spawning a process.
 */

import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'

import { poolFromPg, type DbPool } from '../db/client.js'

/** A pool plus the only teardown a caller needs. */
export type OpenedPool = {
  readonly pool: DbPool
  readonly end: () => Promise<void>
}

export function openPool(connectionString: string): OpenedPool {
  const pool = new Pool({ connectionString })

  return {
    pool: poolFromPg(pool),
    end: async (): Promise<void> => {
      await pool.end()
    },
  }
}

/**
 * Read a required environment variable.
 *
 * Unlike the service configuration, these CLIs do not fall back to a default: a release
 * step that silently targeted the wrong database would be worse than one that refused
 * to run.
 */
export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`)
  }
  return value
}

/** True when this module is the process entry point rather than an import. */
export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href
}

/** Run a CLI body, reporting failure the way a release step needs. Never throws. */
export async function runCli(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(`[mstamp] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
