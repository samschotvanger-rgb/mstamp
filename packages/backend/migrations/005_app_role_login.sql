-- 005_app_role_login.sql - let the application role actually connect.
--
-- Migration 002 used `CREATE ROLE`, which defaults to NOLOGIN. The test harness
-- switches into the role with `SET ROLE`, which does not require LOGIN, so every
-- row-level-security assertion passed while a real client could not authenticate as
-- `mstamp_app` at all. Connecting as the table owner instead silently bypasses RLS,
-- because owners bypass it by default - which is the exact failure this feature exists
-- to prevent, and it would have looked like success.
--
-- The password is deliberately NOT here. A password in a migration file is a password
-- in the git history forever, and migrations are checksummed so it could never be
-- rotated. `pnpm migrate` sets it from MSTAMP_APP_PASSWORD at release time.
--
-- Idempotent: granting LOGIN to a role that already has it is a no-op.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mstamp_app') THEN
    EXECUTE 'ALTER ROLE mstamp_app WITH LOGIN';
  END IF;
END
$$;
