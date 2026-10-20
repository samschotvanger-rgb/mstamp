# Deploying the backend

This is a runbook for standing up the notary. **It has been exercised against a
real Postgres only by the test suite** (via PGlite, which is real Postgres in WASM)
— no hosted deployment has been performed. Treat the order below as the contract
and verify each step as you go.

Nothing here is required to publish or use `@mstamp/protocol`. The library works
in local mode with no server at all. See the README's *The notary is not running*.

## What you need

- **A Postgres database.** Railway, Neon, Supabase, or your own.
- **Two connection strings** — this is the part that is easy to get wrong.
- **Three secrets** — a signing key, a master key, and an app-role password.
- **Node 22+** if running the commands outside the platform.

### The two connection strings

| variable | role | used by |
| --- | --- | --- |
| `DATABASE_URL` | `mstamp_app` | the running service |
| `MIGRATION_DATABASE_URL` | database owner | `pnpm migrate`, `pnpm issue-key` |

This is not redundancy. Row-level security is **bypassed by table owners and
superusers**, so a service connected as the owner has no tenant isolation at all —
and every test still passes, because the tests switch roles explicitly. The
service must connect as `mstamp_app`.

Migration `002` creates that role with `CREATE ROLE`, which defaults to `NOLOGIN`.
Migration `005` grants `LOGIN`, and `pnpm migrate` sets its password from
`MSTAMP_APP_PASSWORD`. Before those existed, a real deployment could not
authenticate as the app role at all.

## Generate the secrets

```sh
# Ed25519 signing seed and payload-encryption key: 32 bytes each.
openssl rand -base64 32   # -> MSTAMP_SIGNING_KEY
openssl rand -base64 32   # -> MSTAMP_MASTER_KEY
openssl rand -base64 24   # -> MSTAMP_APP_PASSWORD
```

**Back up the signing seed before you deploy.** If you lose it you cannot sign
again under that key id; if you leak it, someone can forge receipts that verify
against the public key you publish. Neither is recoverable. There is no rotation
tool yet — `GET /v1/keys` publishes every key ever used precisely so that adding
a new one never orphans old receipts.

**`MSTAMP_SIGNING_KEY_ID` is required and has no default.** A receipt names its signing
key only by that id — it carries no issuer field — so two deployments sharing one cannot
be told apart by a verifier. Pick something unique to this deployment, e.g.
`acme-2026-01`.

**The published test fixtures are rejected at startup.** `test/helpers/keys.ts` holds 32
bytes of `0x01` through `0x04` so the pinned digests stay reproducible. A service signing
with one of those would issue receipts anyone who has read this repository can forge, and
it would look completely healthy from the inside. `MSTAMP_ALLOW_TEST_KEYS=1` disables the
check, and belongs only in the test suite.

## Deploy order

Each step is a compiled entry point, so it works the same on a platform or by hand.

### 1. Migrate (runs as owner)

```sh
node packages/backend/dist/bin/migrate.js
```

Applies every `.sql` file in order, each in its own transaction, and records a
checksum per file. Running it twice applies nothing the second time. Editing an
already-applied migration is refused rather than ignored.

If `MSTAMP_APP_PASSWORD` is set, it also runs `ALTER ROLE mstamp_app WITH LOGIN
PASSWORD …`. If it is unset, the existing password is left alone.

### 2. Issue the first API key

```sh
node packages/backend/dist/bin/issue-key.js --name "Acme Scrapers" --plan pro
```

Prints a tenant id and an API key **once**. Only `sha256:<hex>` is stored, so the
key cannot be recovered — copy it into your secret manager immediately.

Use `MIGRATION_DATABASE_URL` for this; it is an administrative action.

### 3. Start the service

```sh
node packages/backend/dist/bin/../serve.js    # equivalently: pnpm start
```

Validates configuration, publishes the signing public key, *then* binds the port.
That order means a receipt is never signed with a key a verifier cannot yet look
up. It refuses to start if a required variable is missing, in development too.

### 4. Schedule the purge (daily)

```sh
node packages/backend/dist/bin/purge.js
```

Connects as `mstamp_app`, because the delete goes through a `SECURITY DEFINER`
function (`mstamp_purge_expired_payloads()`) that crosses tenants deliberately. A
plain `DELETE` as the app role with no `app.tenant_id` matches **zero rows** — the
job would report success and retain everything.

This is not optional if you store `full`-registration payloads: seven-day
retention is a published promise.

## Railway

`railway.json` in the repository root configures it:

- **Build:** `pnpm install --frozen-lockfile && pnpm run build`
- **Pre-deploy:** `node packages/backend/dist/bin/migrate.js`
- **Start:** `node packages/backend/dist/serve.js`
- **Health check:** `/v1/health`

Add a Postgres service, then set `DATABASE_URL` to the **app role** connection and
`MIGRATION_DATABASE_URL` to the owner connection. Railway gives you the owner URL
by default — do not paste it into `DATABASE_URL`.

Add a separate cron service for `purge.js`, daily. Keep `MSTAMP_APP_PASSWORD` set
so the app role's password is re-applied on every deploy rather than drifting.

## Docker

A `Dockerfile` is included as an alternative. **It has not been built** — Docker
was not available where it was written. Verify before relying on it:

```sh
docker build -t mstamp-backend .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=... -e MSTAMP_SIGNING_KEY=... -e MSTAMP_MASTER_KEY=... \
  mstamp-backend
```

## Verify the deployment

```sh
curl https://your-host/v1/health
curl https://your-host/v1/keys          # public keys; check your keyId is listed
curl https://your-host/v1/keys/current

# An authenticated round trip:
curl -H "X-API-Key: $MSTAMP_API_KEY" https://your-host/v1/whoami
```

Then point the SDK at it:

```js
new Telemetry({
  mode: 'cloud',
  apiKey: process.env.MSTAMP_API_KEY,
  endpoint: 'https://your-host',
  defaultRegistration: 'hash-only',
  sdkVersion: '0.1.1',
})
```

## What this deployment does not include

Be aware before promising anyone anything:

- **No rate limiting.** Ingest accepts batches of up to 100 events per call with no
  per-tenant throttle.
- **No metrics or structured logs.** `console.error` only.
- **No key rotation tooling.** A new `MSTAMP_SIGNING_KEY_ID` works; nothing
  automates it.
- **No TLS.** Terminate at the platform.
- **No timestamping.** Signatures prove authorship, not time — a leaked key can
  forge a backdated receipt. See D-007.
