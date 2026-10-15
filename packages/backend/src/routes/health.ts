import { Hono } from 'hono'

import type { AppEnv } from '../env.js'

/**
 * `GET /v1/health` - public, unauthenticated.
 *
 * Deliberately public: Railway's health check and any uptime monitor needs it, and
 * it exposes nothing beyond the fact that the process is up and which version it is
 * running.
 */
export function healthRoutes(version: string): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/', (c) => c.json({ status: 'ok', version }))

  return routes
}
