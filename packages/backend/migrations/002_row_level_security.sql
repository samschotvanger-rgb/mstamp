-- 002_row_level_security.sql - tenant isolation, enforced by the database.
--
-- The threat this closes: a route that forgets a `WHERE tenant_id = ...` clause, or
-- gets it from the wrong place. Application-level filtering fails open; RLS fails
-- closed. If `app.tenant_id` is unset, `current_setting(..., true)` returns NULL and
-- the policy compares NULL, which is not true - so the tenant sees NO rows rather
-- than every row.
--
-- Three things have to be true for this to actually protect anything, and all three
-- are easy to get wrong:
--
--   1. **The app must not connect as the table owner.** Owners and superusers bypass
--      RLS entirely, even with the policy in place. That is why this file creates a
--      separate `mstamp_app` role and grants it only the privileges it needs.
--   2. **`app.tenant_id` must be set with SET LOCAL, never SET.** SET is
--      session-scoped and would leak the previous request's tenant to the next
--      request that reuses the same pooled connection. `db/client.ts` is the only
--      thing that sets it, and it uses `set_config(..., true)` inside a transaction.
--   3. **The policy needs WITH CHECK, not just USING.** USING filters what can be
--      read; without WITH CHECK a tenant could still INSERT rows claiming to belong
--      to someone else. Asserted in the tests.
--
-- `tenants` deliberately has NO RLS: the API key middleware must resolve a tenant
-- from a key before any tenant is known, so that lookup cannot be tenant-scoped.

-- The application role. Idempotent, because a deployer may have provisioned it
-- already (and may lack CREATEROLE, in which case the DO block is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mstamp_app') THEN
    EXECUTE 'CREATE ROLE mstamp_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO mstamp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, receipts, payloads TO mstamp_app;

-- So tables added by later migrations are covered without remembering to grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mstamp_app;

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payloads ENABLE ROW LEVEL SECURITY;

-- Dropped and recreated rather than guarded, so editing the policy below is a
-- plain redeploy instead of a manual step.
DROP POLICY IF EXISTS tenant_isolation ON receipts;
CREATE POLICY tenant_isolation ON receipts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON payloads;
CREATE POLICY tenant_isolation ON payloads
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
