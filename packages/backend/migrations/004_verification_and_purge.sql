-- 004_verification_and_purge.sql - two narrowly-scoped privileged operations.
--
-- Both exist because row-level security is doing its job. RLS is enabled on `receipts`
-- and `payloads` with no `FORCE`, so the table owner - and only the table owner -
-- bypasses it. The application role is deliberately not the owner, which is what makes
-- tenant isolation real. But two operations legitimately need to cross tenants:
--
--   1. **Public receipt verification.** `GET /v1/receipts/:id/verify` has no credentials
--      by design, so there is no tenant to scope it by. The receipt id is the capability:
--      `rcpt_` + 21 characters from a 64-symbol alphabet, about 126 bits, and the route
--      exposes only `{ valid, receiptId, signedAt, attestation, keyId }` - never the
--      receipt contents. Without knowledge of the id, nothing here is reachable.
--
--   2. **The purge job.** `DELETE FROM payloads WHERE expires_at < now()` is inherently
--      global. Run as the app role with no `app.tenant_id` set, RLS would match ZERO
--      rows and the job would silently do nothing while reporting success - the worst
--      possible failure for a retention guarantee.
--
-- The alternative - granting `mstamp_app` `BYPASSRLS` - would remove tenant isolation
-- everywhere. `SECURITY DEFINER` scopes the privilege to exactly these two operations.
--
-- `SET search_path = public, pg_temp` on each function is not decoration: a
-- `SECURITY DEFINER` function without a pinned search_path can be hijacked by a caller
-- who creates a shadowing object in a schema earlier on the path.

CREATE OR REPLACE FUNCTION mstamp_get_receipt_for_verification(p_receipt_id text)
RETURNS SETOF receipts
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM receipts WHERE id = p_receipt_id
$$;

CREATE OR REPLACE FUNCTION mstamp_purge_expired_payloads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM payloads WHERE expires_at < now();

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Functions default to EXECUTE for PUBLIC. Revoke first, then grant to exactly the role
-- that needs it.
REVOKE ALL ON FUNCTION mstamp_get_receipt_for_verification(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mstamp_purge_expired_payloads() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION mstamp_get_receipt_for_verification(text) TO mstamp_app;
GRANT EXECUTE ON FUNCTION mstamp_purge_expired_payloads() TO mstamp_app;

-- The purge job deletes only from `payloads`. It cannot touch `receipts`: receipts are
-- the evidence, payloads are the retention-limited convenience copy.
COMMENT ON FUNCTION mstamp_purge_expired_payloads() IS
  'Deletes expired payload previews only. Receipts are never purged.';
