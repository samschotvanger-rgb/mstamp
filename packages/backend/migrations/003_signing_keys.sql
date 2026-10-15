-- 003_signing_keys.sql - published public keys.
--
-- Public keys are published and NEVER deleted. A receipt signed three years ago must
-- still verify, so removing a rotated key would silently make every receipt it signed
-- unverifiable - destroying exactly the evidence this product exists to preserve. The
-- app role is therefore granted SELECT and INSERT but not DELETE: the guarantee is
-- enforced by privilege, not just by discipline.
--
-- There is deliberately no row-level security here. These are public keys, and a
-- verifier needs them before it has any tenant context - the same reasoning that keeps
-- `tenants` unscoped.

CREATE TABLE IF NOT EXISTS signing_keys (
  key_id       TEXT PRIMARY KEY,
  algorithm    TEXT NOT NULL DEFAULT 'ed25519',
  -- Base64 of the raw 32-byte Ed25519 public key. The private key is never stored.
  public_key   TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON signing_keys TO notched_app;
