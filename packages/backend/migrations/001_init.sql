-- 001_init.sql - core tables.
--
-- Column names and types follow the V1 handoff's Postgres schema, with two
-- deliberate differences, both ruled on 2026-10-13:
--
--   1. `schema_version` and `key_id` are added. The handoff's schema was written
--      before those fields existed in the Receipt type; see docs/receipt-schema.md.
--
--   2. `server_signature` and `signed_at` are NULLABLE. The handoff had
--      `signed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, but a receipt is INSERTed
--      before it is signed and UPDATEd in place afterwards. A NOT NULL default would
--      have recorded a signing time that was really just an ingest time.
--
-- Everything here is idempotent so the migration can be re-run safely.

CREATE TABLE IF NOT EXISTS tenants (
  id                TEXT PRIMARY KEY,
  -- SHA-256 of the API key, in the protocol's tagged form ("sha256:<hex>").
  -- Plain SHA-256 is correct here only because keys are high-entropy random
  -- strings, not user-chosen passwords: there is nothing to brute-force or
  -- rainbow-table. Never store the key itself.
  api_key_hash      TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan              TEXT NOT NULL DEFAULT 'free',
  spend_limit_cents INTEGER NOT NULL DEFAULT 20000
);

CREATE TABLE IF NOT EXISTS receipts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  seller_id        TEXT,
  provider         TEXT NOT NULL,
  operation        TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_hash    TEXT NOT NULL,
  status_code      INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  timestamp        TIMESTAMPTZ NOT NULL,
  registration     TEXT NOT NULL,
  attestation      TEXT NOT NULL,
  validation       JSONB NOT NULL,
  anomaly          JSONB,
  buyer_override   JSONB,
  sdk_version      TEXT NOT NULL,
  schema_version   TEXT NOT NULL,
  key_id           TEXT,
  server_signature TEXT,
  signed_at        TIMESTAMPTZ
);

-- The two access patterns the CLI and scorecards need: a tenant's receipts over
-- time, and a tenant's receipts for one provider over time.
CREATE INDEX IF NOT EXISTS receipts_tenant_timestamp_idx
  ON receipts (tenant_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS receipts_tenant_provider_timestamp_idx
  ON receipts (tenant_id, provider, timestamp DESC);

CREATE TABLE IF NOT EXISTS payloads (
  receipt_id TEXT PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  -- AES-256-GCM ciphertext. Never plaintext: a raw body preview is exactly the
  -- thing the redaction and registration machinery exists to bound.
  encrypted  BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Drives the daily purge job.
CREATE INDEX IF NOT EXISTS payloads_expires_at_idx ON payloads (expires_at);
