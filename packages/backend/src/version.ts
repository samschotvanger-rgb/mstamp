/**
 * The backend version reported by `/v1/health`.
 *
 * Read from `package.json` rather than duplicated as a constant, so the health
 * endpoint cannot drift from what was actually published. `../package.json` resolves
 * to the same file from `src/` and from `dist/`.
 */

import { readFileSync } from 'node:fs'

type PackageManifest = { version?: unknown }

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as PackageManifest
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    // A missing manifest must not stop the process from serving health checks.
    return '0.0.0'
  }
}

export const BACKEND_VERSION: string = readVersion()
