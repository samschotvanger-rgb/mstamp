import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Point the workspace package at its SOURCE, so the backend suite runs without
      // building @notched/protocol first. Production still resolves the built dist/
      // through the normal node_modules symlink; this only affects tests and mirrors
      // the `paths` entry in tsconfig.json.
      '@notched/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Postgres-in-WASM boots once per file; give it room without hiding real hangs.
    testTimeout: 20_000,
  },
})
