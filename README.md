# mstamp

A cryptographic evidence layer for external API calls made by AI agents: a `fetch` wrapper records what was sent and what came back as SHA-256 hashes, and a backend signs the resulting receipt with Ed25519 so anyone can verify it later.

Not a proxy. Not a judge. A neutral notary.

mstamp runs inside the caller's own process. It wraps `fetch`, captures the request and the response, optionally validates the response against rules the caller declares, and can send the observation to a backend that signs it. The output is a receipt: a small JSON document that a third party can verify offline with nothing but the receipt and the signer's public key. mstamp never sits in the request path, never forwards or rewrites traffic, and never decides whether an API is "good". It records what happened and stays out of the way. The first vertical is web scrapers, where a call returns `200 OK` with a body that is empty, stale or structurally wrong — failures a status code cannot express and a receipt can.

**Contents:** [Status](#status) · [What mstamp is not](#what-mstamp-is-not) · [Repository layout](#repository-layout) · [Requirements](#requirements) · [Commands](#commands) · [Quickstart](#quickstart) · [Receipts](#receipts) · [Validation](#validation) · [Verifying a receipt](#verifying-a-receipt) · [Known limitations](#known-limitations) · [Backend](#backend) · [Security](#security) · [License](#license)

## Status

Early, pre-release work, but installable. `@mstamp/protocol` is published:

```sh
npm install @mstamp/protocol
```

`@mstamp/backend` is **not** published. It is a service rather than a library, so it stays `private: true` and runs from this repository.

The wire format is not frozen. `schemaVersion` is `"1"` and the field set is documented normatively, but expect breaking changes before a first release. A change that alters the signed field set is a protocol-version decision, never a refactor, and the pinned digests below exist to make that failure loud instead of silent.

What exists today: the library (RFC 8785 canonicalization, SHA-256 hashing, redaction, response validation, non-mutating `fetch` interception, a fail-open queue, a local SQLite receipt store, and the cloud transport) and the backend (Hono app, ingest, Ed25519 signing, public key publication, tenant-isolated Postgres storage, public verification, and a payload retention job). What does not exist yet: a frozen wire guarantee and an external cryptographic review of the canonicalization and signing path. Treat both halves as work in progress.

### The notary is not running

There is no hosted mstamp service, so there is no endpoint to point `mode: 'cloud'` at. `@mstamp/backend` is source in this repository: it is tested against real Postgres, but it has never been deployed, and no API keys have ever been issued.

That is deliberate. Operating a signer means holding an Ed25519 key whose entire purpose is to be trusted by strangers, plus a database holding their receipt hashes on a retention schedule. A leaked signing key forges receipts that verify against the published public key, so taking custody of one is a permanent security obligation. Taking it on before anyone wants to buy receipts would be a liability, not a feature.

**So, plainly:** the npm package gives you a local audit log and the constraint layer — canonicalization, hashing, redaction, validation — with no third-party attestation. A signed receipt needs a signer that is *not you*, and there isn't one running. A notary you host yourself proves nothing a local receipt doesn't, because you hold the key.

The backend is **deployable**. [docs/deploy.md](docs/deploy.md) is a runbook: migrate a database, issue an API key, start the service, schedule the retention job. Deployable is not deployed, though — there is no hosted instance, and that is on purpose rather than an oversight.

**If you want signed receipts**, [open an issue](https://github.com/samschotvanger-rgb/mstamp/issues) and describe what you need. Standing up the notary is the work that follows, not the work that is done.

## What mstamp is not

- **Not a proxy.** Traffic is not routed through mstamp. The call the caller makes is the call the provider receives; there is no middlebox to be a single point of failure, a latency tax, or a place where credentials have to land.
- **Not a judge.** mstamp does not score an API, rank providers or decide what "good data" means. Callers declare their own validation rules; mstamp records whether those rules passed and signs that record.
- **Not a privacy amplifier.** Redaction happens before hashing, and what leaves the process is bounded by the `registration` mode on each call. The resulting trade-offs are listed under [Known limitations](#known-limitations).

That posture is the design: a receipt is useful to a third party precisely because mstamp is not asking anyone to trust it.

## Repository layout

```
mstamp/
├── packages/
│   ├── protocol/                  # wire types + everything the SDK does
│   │   ├── src/                   # types, canonical, hash, redact, receipt, validate,
│   │   │                          #   queue, intercept, local-db, cloud, telemetry
│   │   └── test/                  # unit, integration and conformance suites
│   └── backend/                   # the signing and storage service
│       ├── migrations/            # numbered .sql files, applied in filename order
│       ├── src/                   # app, auth, config, serve, crypto, db, routes
│       └── test/                  # runs against real PostgreSQL in WASM
├── docs/
│   ├── receipt-schema.md             # normative field set + verification recipe
│   ├── canonicalization-decision.md  # why the canonicalizer was chosen
│   ├── decisions-public.md           # the decisions that constrain the protocol
│   └── deploy.md                     # runbook: migrate, issue a key, start, cron
├── scripts/
│   └── test-canonicalization.ts      # independent verifier path, cross-checked
└── package.json
```

All logic shared between the library and the backend lives in `packages/protocol`, so the signer and a verifier cannot drift apart. The backend imports the signing payload from there rather than reimplementing it. The canonicalizer was selected by a measured comparison against the alternatives, recorded in [docs/canonicalization-decision.md](docs/canonicalization-decision.md).

Wherever a source comment or this README cites a numbered decision such as `D-015`, it resolves in [docs/decisions-public.md](docs/decisions-public.md) — the subset of the decision log that constrains the wire format, the hashes and the privacy posture. Entry numbers match the full internal log, so the citations stay stable.

## Requirements

- **Node.js 22 or newer.** The selected RFC 8785 implementation requires it, and the local receipt store uses `node:sqlite`.
- **ESM only.** The package is `"type": "module"`. Import it from an `.mjs` file or a project with `"type": "module"`. `require()` also works on Node 22.12 and later.
- **pnpm, to work on this repository.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, a 24-hour soak window: pnpm refuses to adopt a package version published less recently than that. It is a floor, not a strong control, and is intended to be raised. Installing the *library* needs only npm.

## Commands

```sh
pnpm install          # install the workspace
pnpm test             # @mstamp/protocol suite, then @mstamp/backend, then the root suite
pnpm run typecheck    # tsc across the root scripts and every package
pnpm run build        # compile every package to dist/

# per-package
pnpm --filter @mstamp/protocol test
pnpm --filter @mstamp/backend test
pnpm --filter @mstamp/protocol run typecheck
pnpm --filter @mstamp/protocol run test:watch

# the canonicalization bake-off on its own
pnpm --filter @mstamp/protocol exec vitest run test/bakeoff.test.ts
```

## Quickstart

```sh
npm install @mstamp/protocol
```

Local mode needs no server: receipts go to a local SQLite file and nothing leaves the process.

```js
import { Telemetry } from '@mstamp/protocol'

const telemetry = new Telemetry({
  mode: 'local',
  defaultRegistration: 'hash-only',
  sdkVersion: '0.1.0',
})

// A fetch that records every call it makes. The caller's request and response are
// untouched: the same Response object comes back, still fully readable.
const observedFetch = telemetry.instrumentFetch({ provider: 'scraper-x', operation: 'extract' })

const response = await observedFetch('https://your-api.example/items?page=1')
const items = await response.json()
```

Replace that URL with one you can actually call; the receipt lands in `.mstamp/receipts.db`.

**One timing detail, and it bites.** The receipt is written on a background tick once the response body has been read. `close()` is synchronous and does not wait for that write, so calling it in the same tick discards the receipt silently. Let the process idle, or close at shutdown rather than after each request.

Those receipts are unsigned (`attestation: "self"`). To get a **signed** receipt, point the same code at a running backend instead:

```js
const telemetry = new Telemetry({
  mode: 'cloud',
  apiKey: process.env.MSTAMP_API_KEY,           // required in cloud mode
  endpoint: 'https://ingest.example.com',       // required in cloud mode, no default
  defaultRegistration: 'hash-only',             // 'full' also sends redacted previews
  registrationPolicy: { 'scraper-x': 'full' },  // per-provider override
  sdkVersion: '0.1.0',
})

// ...the same instrumentFetch call as above...

await telemetry.flush()   // await the cloud POST; never rejects
```

A single call can be recorded without building a wrapper, with per-call rules:

```js
await telemetry.wrap(fetch, url, init, {
  provider: 'scraper-x',
  operation: 'extract',
  rules: ['min-length:items:1'],
})
```

`Telemetry` decides two things and nothing more: which `registration` applies (per call, then per-provider policy, then the configured default), and whether to enqueue a cloud POST. **It never signs.** In `local` mode, receipts are written unsigned to `.mstamp/receipts.db` (`attestation: "self"`, with `keyId`, `serverSignature` and `signedAt` all `null`); the backend is what makes a receipt a signed, `"platform"`-attested one. Use `isSignedReceipt()` rather than checking those fields by hand — a signature without a signing time is not a usable attestation.

Configuration mistakes throw at construction, not at request time: a missing API key or `endpoint` in cloud mode, or a missing `sdkVersion`, fails immediately rather than as a silent absence of receipts. Interception itself is fail-open; a capture that cannot complete is abandoned and the caller's call is unaffected. **There is no default endpoint, deliberately** — "where does my telemetry go" is the caller's decision, so the library refuses to make it. `endpoint` is required in cloud mode and unused in local mode, where nothing is ever posted.

## Receipts

A receipt carries `schemaVersion`, `receiptId`, `tenantId`, `provider`, `operation`, `requestHash`, `responseHash`, `statusCode`, `latencyMs`, `timestamp`, `registration`, `attestation`, `validation`, `sdkVersion`, `keyId`, `serverSignature` and `signedAt`, plus two fields reserved for a later schema (`anomaly` and `buyerOverride`, always `null` in `schemaVersion` `"1"`). The signing payload is the RFC 8785 canonical form of the receipt with `serverSignature` and `signedAt` removed **entirely**, not set to `null`. Both the signer and any verifier must call `receiptSigningPayload()` from `@mstamp/protocol` rather than reimplementing that rule; a reimplementation that disagrees by one field makes every receipt unverifiable, silently.

The full field set, the hash formats and a worked example are normative in [docs/receipt-schema.md](docs/receipt-schema.md).

### The two hashes are deliberately different

| | `requestHash` | `responseHash` |
| --- | --- | --- |
| Input | the request body after redaction, then RFC 8785 canonicalization | the response body exactly as received |
| Byte-faithful to the wire? | no | yes |

This asymmetry is intentional and disclosed. Redaction runs before hashing so a secret is never stored or transmitted — the hash covers the `<redacted>` placeholder, which means `requestHash` is a commitment to a redacted *projection* and cannot prove what was in the redacted positions. `responseHash` covers the raw bytes because hashing before parsing is the only way to cover a malformed, truncated or non-JSON response, which is exactly the failure class mstamp exists to catch. `responseHash` is recomputable by anyone holding the response bytes; `requestHash` is not, because a third party does not have the unredacted original and canonicalization reorders keys and renormalises numbers regardless.

### Sentinels: a hash slot that is not a hash

Two situations produce no faithful hash. Rather than invent a digest, the hash slot holds a sentinel and the receipt carries a matching `unvalidated:` rule:

| Situation | Hash slot | Rule | `validation.passed` |
| --- | --- | --- | --- |
| Request body was a `FormData`, `Blob` or `ReadableStream` | `sentinel:unsupported-body-type` | `unvalidated:unsupported-body-type` | `null` |
| Response body exceeded `maxResponseBytes` | `sentinel:oversize` | `unvalidated:oversize` | `null` |

The `sentinel:` prefix is load-bearing. `sha256:unsupported-body-type` would look like a malformed digest and invite a verifier to treat it as corruption; `sentinel:` cannot be mistaken for a digest by any format check, and `isHash(sentinel)` is `false`. A sentinel does not invalidate the signature — it sits inside the signed payload like any other value — but it means the receipt does not cover those bytes.

The default `maxResponseBytes` is 1 MB, and the read stops as soon as the cap is exceeded rather than buffering the whole body. The caller still receives every byte. The cost is stated plainly: **a response over the cap is not covered by the receipt.** Raise the cap for a provider where that matters.

## Validation

Rules are built-in strings; a schema (anything with a Zod-style `safeParse`) can be supplied alongside them. If both are present, both must pass for `validation.passed` to be `true`. The six built-in rules are `non-empty`, `has-field`, `min-length`, `freshness`, `numeric-range` and `no-duplicates`, each parameterised by a dot-separated path. A misspelled rule spec throws rather than silently doing nothing, because a validation gap that reports success is worse than a visible failure.

Two semantics matter when reading a receipt. **`passed: null` means "not validated", not "passed"** — with no rules and no schema, nothing was checked, so claiming a pass would be a false assertion of quality, and anything consuming a pass rate must exclude nulls. And **a non-JSON body is hashed and marked `unvalidated:non-json` with `passed: null`**: not an error, just nothing to validate structurally.

Validation runs in the SDK, never on the server. The backend stores the verdict; it does not compute one.

## Verifying a receipt

A verifier needs only the receipt JSON and the Ed25519 public key named by its `keyId`. They do not have to trust mstamp, hold an account, or be online for anything except fetching the key.

1. Read `schemaVersion` and confirm the field set is known.
2. Read `keyId`. If it is `null`, the receipt is unsigned: the only claim it supports is `attestation: "self"`. Stop.
3. Remove `serverSignature` and `signedAt`.
4. Canonicalize the remainder per RFC 8785 — UTF-8, sorted keys, no whitespace, ECMAScript number formatting, and **no Unicode normalization**.
5. Verify the signature over those bytes with the key named by `keyId`.

Step 4 is where independent implementations go wrong. The IETF conformance vectors are vendored at `packages/protocol/test/vectors/rfc8785.ts` so a third-party implementation can be checked before it is trusted. Two digests are pinned as tripwires:

- The signing payload of the worked example in `docs/receipt-schema.md` hashes to `sha256:5c5390bb0a90ad90d7e5a9226edc398d3a2cdc84df2e28b8885ee1a5c04070c7`. If that changes, the signed field set changed and previously issued receipts became unverifiable.
- The RFC 8785 ES6 number-serialization conformance file hashes to `be18b62b6f69cdab33a7e0dae0d9cfa869fda80ddc712221570f9f40a5878687`. That value comes from the IETF project's own published checksum, and it covers 1,000 generated lines of number-formatting edge cases. It is unchanged by receipt schema edits, which is how the canonicalizer itself is shown not to have moved.

The backend publishes every public key it has ever used at `GET /v1/keys`, and never deletes one, so rotating a signing key does not orphan history. Removing a retired key would make every receipt it signed permanently unverifiable, which is the opposite of the point. `GET /v1/keys/current` is served from memory, so a database outage does not stop verification of a receipt you already hold. `scripts/test-canonicalization.ts` exercises this path independently: it rebuilds the signed bytes with the raw canonicalizer and a hand-rolled field removal, emulating a third party with no access to `@mstamp/protocol`.

## Known limitations

Deliberate scope decisions, recorded so they are not mistaken for oversights.

- **Secrets are detected by field name, not by value.** A key pasted into a `description` field is not redacted. Add provider-specific names through `RedactionPolicy.bodyKeys`.
- **URL paths are not redacted.** Credentials in userinfo and sensitive query parameters are stripped; a token embedded in a path survives.
- **Non-plain objects are rejected, not coerced.** A `Date`, `Map` or class instance reaching the canonicalizer throws rather than silently becoming `{}`.
- **Unicode is preserved as-is.** `A` + U+030A and U+00C5 are distinct inputs with distinct hashes, because RFC 8785 forbids normalization. Any NFC-normalizing implementation will disagree with mstamp and fail the official vector.
- **Interception buffers at most `maxResponseBytes`.** A response over the cap is not covered by the receipt; it carries `sentinel:oversize`.
- **A failed call is not captured.** If the underlying `fetch` rejects there is no status or response to record, so nothing is written. Provider-downtime evidence would need a schema change.
- **A non-JSON body gets no preview even in `full` mode**, because structural redaction is impossible for it and a raw preview could disclose a credential verbatim. The hash is unaffected.
- **A cloud-mode local draft records `tenantId: "tnt_local"`** unless one is configured. The authoritative tenant is resolved by the backend from the API key; the local row is a draft.
- **Timestamps are normalised to millisecond precision** on the way in. The receipt `timestamp` is inside the signed payload and round-trips through a `timestamptz` column, so a higher-precision value would come back as different text and fail verification.
- **No external cryptographic review yet.**

## Backend

The backend is a Hono app over Postgres. It signs receipts; it does not compute validation verdicts.

### Configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | What the **service** connects as. Must be `mstamp_app`. Required. |
| `MIGRATION_DATABASE_URL` | What **migrations and key issuance** connect as: the database owner. Required for those steps; unused by the running service. |
| `MSTAMP_APP_PASSWORD` | Password for `mstamp_app`, applied by the migrate step. Omitting it leaves the existing password unchanged. |
| `MSTAMP_SIGNING_KEY` | Base64 of the 32-byte Ed25519 seed. Required. |
| `MSTAMP_SIGNING_KEY_ID` | Key id published with the public key. **Required, no default** — a receipt names its signing key only by this id, so two deployments sharing one are indistinguishable to a verifier. |
| `MSTAMP_MASTER_KEY` | Base64 of the 32-byte payload encryption key. Required in every mode. |
| `PORT` | Listen port. Defaults to `3000`. |
| `HOST` | Interface to bind. Defaults to `0.0.0.0`; binding loopback produces a deploy that starts cleanly and never answers. |

**The service refuses to start without them, and there is no fallback key.** It refuses in development too: a dev server that boots without a key and then rejects every receipt teaches the wrong thing about how the service works. A key id already published under a *different* public key is also a hard stop, because overwriting it breaks verification for every receipt already signed under that id while leaving it breaks every future one — neither is recoverable, so the process refuses rather than guessing.

**Two connection strings, and the difference is a security boundary.** Row-level security is bypassed by table owners and superusers, so the service and its migrations need *different* roles: `DATABASE_URL` is the app role, `MIGRATION_DATABASE_URL` is the owner. A deployment carrying only one URL is misconfigured in a way that looks completely healthy — the service runs, every test passes, and tenant isolation does not exist. `docs/deploy.md` is the runbook.

The deployable entry point is `packages/backend/src/serve.ts`, which after `pnpm run build` runs from `packages/backend/dist/serve.js`. It validates configuration, publishes the public key, and only then binds a port, so a receipt can never be signed with a key a verifier cannot yet look up. The test fixture signing key lives in `packages/backend/test/`, never in `src/`: a hard-coded seed in shipped code is a known private key, and deploying with it because it worked locally is a silent, catastrophic failure. Tests inject the key explicitly, so nothing in `src/` needs a test mode.

### Migrations

Numbered `.sql` files in `packages/backend/migrations/`, applied in filename order by `migrate()` (`src/db/migrate.ts`). There is no ORM, so the schema is the SQL and is reviewable in a diff. Each migration runs in its own transaction — Postgres has transactional DDL, so a failure leaves neither partial schema nor a record of having run — and **applied migrations are checksummed**: editing one that has already run is refused, because the deployed database would never see the change and would silently diverge from a fresh one. Migrations are append-only.

```sh
# from the repository root, after `pnpm run build`
node packages/backend/dist/bin/migrate.js                    # owner: schema + app-role password
node packages/backend/dist/bin/issue-key.js --name "Acme"   # owner: prints a new tenant's key once
node packages/backend/dist/serve.js                         # the service
node packages/backend/dist/bin/purge.js                     # app role: expired previews
```

`migrate` connects as the **owner** (`MIGRATION_DATABASE_URL`), applies any pending files, then sets the app role's password from `MSTAMP_APP_PASSWORD`. `issue-key` stores only the `sha256:` hash of the key it prints, so the key cannot be recovered afterwards — copy it immediately. `purge` connects as the app role and deletes expired payloads through a `SECURITY DEFINER` function, because a plain `DELETE` as that role with no tenant set matches zero rows and would report success while retaining everything. Each command exits non-zero with a specific message when a required variable is missing.

`docs/deploy.md` is the full runbook, including which variable goes where on a host.

### Row-level security

RLS is enabled on `receipts` and `payloads` with a `tenant_isolation` policy. The application connects as **`mstamp_app`**, a non-superuser role, because a table owner and a superuser both bypass RLS entirely — running isolation tests as the migration user would make them pass vacuously.

Three details decide whether RLS protects anything:

- **The tenant is set with `SET LOCAL`, never `SET`.** `SET` is session-scoped, so on a pooled connection it survives the request that set it and is inherited by whichever request next checks out that connection, silently granting one tenant access to another's rows. `withTenant` uses `set_config('app.tenant_id', $1, true)` inside a transaction: the third argument is `SET LOCAL`, and the function form is used because a literal `SET LOCAL` cannot take a bind parameter and interpolating one would be an injection hole.
- **The policy has `WITH CHECK`, not just `USING`.** `USING` filters reads; without `WITH CHECK` a tenant could still insert rows claiming to be someone else.
- **It fails closed.** With `app.tenant_id` unset, the comparison is against `NULL` and the tenant sees no rows rather than every row.

The `tenants` and `signing_keys` tables deliberately have no RLS: the API key middleware must resolve a tenant before any tenant is known, and a verifier needs public keys before it has any tenant context. The consequence is that the app role can read all `api_key_hash` values — necessary, and worth remembering.

### Privileged functions

Two operations legitimately cross tenants, and both go through narrowly scoped `SECURITY DEFINER` functions in migration `004` rather than through a relaxed policy:

- **`mstamp_get_receipt_for_verification(text)`** backs the public verify endpoint, which has no credentials and therefore no tenant to scope by. The receipt id is the capability.
- **`mstamp_purge_expired_payloads()`** performs the global expiry delete. Run as the app role with no `app.tenant_id` set, `DELETE FROM payloads WHERE expires_at < now()` matches zero rows: the job would report success and retain everything, which is the worst possible failure for a retention guarantee.

The alternative — granting `mstamp_app` `BYPASSRLS` — would give up tenant isolation everywhere. Each function pins `search_path = public, pg_temp`, because a `SECURITY DEFINER` function without a pinned search path can be hijacked by a caller who creates a shadowing object earlier on the path. Execute is revoked from `PUBLIC` and granted only to `mstamp_app`.

Payload previews are the only near-verbatim caller data stored. Only `full` registration stores them; they are always encrypted with AES-256-GCM under a per-tenant key derived by `HKDF-SHA256` from `MSTAMP_MASTER_KEY`, with the `info` parameter binding the key to the tenant and the purpose; and they expire after seven days. Because the key comes from the tenant, a cross-tenant read fails the GCM authentication tag rather than returning plausible garbage — a second line of defence behind RLS. Receipts are never purged. The job is a function for a scheduler to call; scheduling is deliberately out of scope.

### Ingest status contract

`POST /v1/ingest/batch` takes up to 100 events. It is idempotent on `receiptId` with first write wins, because a receipt is a signed artefact and a re-send must not be able to change what was signed. Each event is stored in its own transaction, so one malformed event rejects only itself; the response reports `accepted` and `rejected` counts per event. A batch over 100 is a `413`.

**`200` means the batch was processed, with per-event results in the body. `503` means the batch was not processed at all, and the caller should retry.** The `503` case exists because a `200` would tell the SDK's queue the batch succeeded, so it would never retry and the telemetry would be lost silently — the opposite of what the fail-open design is for.

### Endpoints

Public, no credentials: `GET /v1/health`, `GET /v1/keys`, `GET /v1/keys/current`, and `GET /v1/receipts/:id/verify` — which returns `{ valid, receiptId, signedAt, attestation, keyId }` and never the receipt contents; a failed verification is a `200` with `valid: false`, and only a missing receipt is a `404`.

Authenticated with an API key: `GET /v1/whoami`, `POST /v1/ingest/batch`, and `GET /v1/receipts/:id`. A receipt read is tenant-scoped by RLS and deliberately has no `WHERE tenant_id = ...` clause — duplicating the filter in application code would mask an RLS bug and would have to be kept in sync forever. A missing or unowned receipt is a `404`, not a `403`, because a `403` would confirm the id exists.

## Security

Signing keys and the payload master key are supplied by environment variable and are never committed; `.gitignore` excludes `.env`, `*.pem` and `*.key`. No secret has a default value in code. If you believe you have found a vulnerability, please report it privately through GitHub's private vulnerability reporting on this repository rather than opening a public issue.

## License

MIT. See [LICENSE](LICENSE).
