import { Hono } from 'hono'

import type { AppEnv } from '../env.js'

/**
 * `GET /v1/whoami` - requires a valid API key.
 *
 * Returns the tenant the key resolves to. Not one of the V1 endpoints; it exists for
 * two reasons, and both are load-bearing for Week 3a:
 *
 *   1. It is the way to verify the middleware resolves the RIGHT tenant, which is
 *      otherwise invisible until 3b/3c add routes that read data.
 *   2. It gives the "any other route without a key returns 401" requirement something
 *      to point at.
 *
 * It is also genuinely useful to a buyer debugging their own integration, and it
 * leaks nothing: the tenant's own id, name, plan and spend limit.
 */
export function whoamiRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/', (c) => {
    const tenant = c.get('tenant')

    return c.json({
      tenantId: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      spendLimitCents: tenant.spendLimitCents,
    })
  })

  return routes
}
