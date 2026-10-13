import { defineConfig } from 'vitest/config'

// Root-level Vitest run. This only covers the cross-package scripts in
// `scripts/` - the per-package suites are run by `pnpm --filter <pkg> test`
// using each package's own config.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'scripts/test-canonicalization.ts'],
    environment: 'node',
  },
})
