# Notched

Cryptographic evidence layer for external API calls made by AI agents.

A lightweight SDK wraps `fetch`, captures request/response hashes, validates the
response against buyer-declared rules, and sends receipts to a backend that signs
them with Ed25519. The receipt is a portable, offline-verifiable proof of what
was delivered.

**Not a proxy. Not a judge. A neutral notary.** Buyer-first, seller-optional.

**First vertical:** web scrapers — buyers are agent builders whose scraper calls
return `200 OK` with broken, stale or empty data.

---

## Status

**Weeks 1–3b complete.** The SDK is feature-complete; the backend signs receipts, accepts
ingest and publishes its keys. Still absent by design: `/v1/receipts`, `/v1/verify`,
payload encryption, the purge job and the CLI.

| Deliverable | State |
| --- | --- |
| pnpm monorepo | done |
| `packages/protocol/src/types.ts` — `Receipt`, `IngestEvent` | done |
| RFC 8785 canonicalization | done, with I-JSON guard |
| SHA-256 hashing | done |
| Redaction (headers, body, URL) | done |
| Receipt signing payload | done |
| Canonicalization conformance suite | done — official IETF vectors |
| `scripts/test-canonicalization.ts` cross-path test | done |
| Canonicalizer library decision record | done — [docs/canonicalization-decision.md](docs/canonicalization-decision.md) |
| `validate.ts` — six built-in rules + schema integration | done |
| `queue.ts` — fail-open queue and circuit breaker | done |
| `intercept.ts` — `fetch` wrapper, non-mutating and fail-open | done |
| `local-db.ts` — SQLite receipt store (`node:sqlite`) | done |
| `cloud.ts` — ingestion transport, 100-event batches | done |
| `telemetry.ts` — the `Telemetry` entry point | done |
| Integration test — silent-failure scenario end to end | done |
| Backend: Hono app + `/v1/health` | done |
| Backend: numbered SQL migrations + runner | done |
| Backend: row-level tenant isolation (RLS) | done |
| Backend: API key auth middleware | done |
| Backend: Ed25519 receipt signing | done |
| Backend: `POST /v1/ingest/batch` | done, idempotent on `receiptId` |
| Backend: `GET /v1/keys` + `/v1/keys/current` | done, public, keys never deleted |

---

## Layout

```
notched/
├── packages/
│   └── protocol/                    # shared by SDK, CLI and backend
│       ├── src/
│       │   ├── types.ts             # Receipt + IngestEvent wire types
│       │   ├── canonical.ts         # RFC 8785 + I-JSON guard
│       │   ├── hash.ts              # SHA-256 ("sha256:<hex>")
│       │   ├── redact.ts            # header / body / URL redaction
│       │   ├── receipt.ts           # the exact bytes the backend signs
│       │   ├── validate.ts          # six built-in rules + optional schema
│       │   ├── queue.ts             # fail-open queue + circuit breaker
│       │   ├── intercept.ts         # non-mutating, fail-open fetch wrapper
│       │   ├── local-db.ts          # SQLite receipt store (node:sqlite)
│       │   ├── cloud.ts             # ingestion transport (/v1/ingest/batch)
│       │   ├── telemetry.ts         # the Telemetry SDK entry point
│       │   └── index.ts
│       └── test/
│           ├── canonical.test.ts    # 55 tests: conformance + guard
│           ├── hash.test.ts         # 12 tests: NIST vectors + crypto cross-check
│           ├── redact.test.ts       # 19 tests
│           ├── receipt.test.ts      # 16 tests
│           ├── validate.test.ts     # 68 tests: every rule, pass/fail/missing
│           ├── queue.test.ts        # 29 tests: drop policy, breaker, retry timing
│           ├── intercept.test.ts    # 32 tests: pass-through, hashes, cap, fail-open
│           ├── local-db.test.ts     # 25 tests: round-trip, concurrency, lifecycle
│           ├── cloud.test.ts        # 16 tests: HTTP contract + fail-open seam
│           ├── telemetry.test.ts    # 38 tests: registration, assembly, resilience
│           ├── integration.test.ts  # 13 tests: the whole pipeline end to end
│           ├── bakeoff.test.ts      # 5 tests: the library decision
│           └── vectors/rfc8785.ts   # vendored IETF conformance corpus
├── scripts/
│   └── test-canonicalization.ts     # SDK vs backend vs independent verifier
├── packages/backend/                # the Notched service
│   ├── migrations/
│   │   ├── 001_init.sql             # tenants, receipts, payloads, indexes
│   │   ├── 002_row_level_security.sql  # app role, RLS, tenant_isolation policy
│   │   └── 003_signing_keys.sql     # published public keys (no DELETE grant)
│   ├── src/
│   │   ├── app.ts                   # createApp: route order is security-relevant
│   │   ├── auth.ts                  # X-API-Key -> tenant, or 401
│   │   ├── config.ts                # the "refuse to start" gate
│   │   ├── env.ts                   # shared Hono env + Tenant type
│   │   ├── serve.ts                 # deployable entry point
│   │   ├── version.ts               # /v1/health version, read from package.json
│   │   ├── crypto/sign.ts           # Ed25519 sign/verify, payload from protocol
│   │   ├── db/client.ts             # withTenant: SET LOCAL, never SET
│   │   ├── db/keys.ts               # key publication, conflict detection
│   │   ├── db/migrate.ts            # numbered SQL runner, checksummed
│   │   ├── db/receipts.ts           # receipt insert/select
│   │   └── routes/{health,whoami,keys,ingest}.ts
│   └── test/                        # 105 tests against real Postgres in WASM
├── docs/
│   ├── canonicalization-decision.md
│   └── receipt-schema.md            # normative V1 field set + verification recipe
└── README.md
```

`packages/sdk` and `packages/cli` do not exist yet. All logic shared between the SDK,
the CLI and the backend lives in `packages/protocol`, so the signer and the verifier
cannot drift apart.

---

## Requirements

- **Node.js 22+** (the selected canonicalizer requires it)
- **pnpm 11+**

Caches are kept inside the repo (`.pnpm-store/`, `.pnpm-cache/`) via `.npmrc`, so
installs are hermetic and work in confined environments where the default global
cache is read-only.

`pnpm-workspace.yaml` sets a **24-hour `minimumReleaseAge`**: pnpm refuses to
adopt a package version published less recently than that. A
minutes-old release is the highest-risk moment in a package's life. This is a
floor, not a strong control — raise it once the tree is stable.

---

## Commands

```sh
pnpm install          # install
pnpm test             # protocol suite, then the root cross-path suite
pnpm run typecheck    # tsc across root scripts + every package
pnpm build            # compile packages to dist/

# the canonicalizer bake-off, on its own
pnpm --filter @notched/protocol exec vitest run test/bakeoff.test.ts

# watch mode
pnpm --filter @notched/protocol run test:watch
```

---

## What is verified

442 tests, all passing.

**Canonicalization is byte-exact RFC 8785.** Verified against the IETF reference
project's own vectors, vendored in `test/vectors/rfc8785.ts`:

1. Six official `testdata/` input/output pairs, compared as raw hex — because
   `values.json` and `weird.json` contain C0 control characters, U+007F, U+0080
   and an astral-plane emoji that cannot be compared reliably as displayed text.
2. RFC 8785 Appendix B's 24-row number table, constructed from IEEE-754 bit
   patterns rather than JS literals so the test cannot be defeated by literal
   rounding.
3. The official ES6 number conformance file — 1,000 generated lines hashing to
   the published checksum `be18b62b…8687`.

**Hashing is cross-checked against an independent implementation.** NIST vectors
plus randomised agreement with Node's OpenSSL-backed `crypto`.

**The independent verifier path matches.** `scripts/test-canonicalization.ts`
rebuilds the signed bytes using the raw canonicalizer and a hand-rolled field
removal, emulating a third party with no access to `@notched/protocol`.

**Redaction runs before hashing and never mutates caller data** — the SDK runs in
process with a live application, so mutating a caller's object would corrupt the
buyer's own data as a side effect of telemetry.

---

## Validation semantics

Rules and an optional schema both run when both are supplied; **both must pass**
for `validation.passed === true`.

| Rule | Fails when |
| --- | --- |
| `non-empty` | body is `{}`, `[]`, `null`, `''`, or absent |
| `has-field:path` | field at `path` is missing or `null` |
| `min-length:path:N` | array at `path` has fewer than `N` items |
| `freshness:path:24h` | ISO timestamp at `path` is older than the duration |
| `numeric-range:path:min:max` | number at `path` is outside the inclusive range |
| `no-duplicates:path` | array at `path` contains a repeated value |

Paths are dot-separated and support array indices (`data.rows.0.id`); they cannot
contain `:`, which separates a rule's arguments. An empty path means the root
value. `no-duplicates` compares elements by RFC 8785 canonical form, so
`{a:1,b:2}` and `{b:2,a:1}` count as duplicates while `1` and `'1'` do not.

**`passed: null` means "not validated", not "passed".** With no rules and no
schema, nothing was checked, so claiming a pass would be a false assertion of
quality. Consumers of a pass rate must exclude nulls rather than counting them as
successes.

**Non-JSON bodies** are hashed and recorded as `passed: null` with rule
`unvalidated:non-json`. Note the distinction: `''` is not JSON at all so nothing
can run against it, whereas `'""'` parses to the empty string and `non-empty`
legitimately fails it.

**Malformed rule specs fail loudly.** A misspelled rule produces an error instead
of silently no-op'ing, because a validation gap that reports success is worse than
a visible failure.

**Zod is supported but not required.** `SchemaLike` is structural (`safeParse`), so
Zod v3/v4, Valibot, ArkType or a hand-rolled validator all work. Zod is a
**devDependency** here, used only to prove real Zod integration in the tests;
`@notched/protocol` carries no runtime dependency on it.

---

## Fail-open queue

| Parameter | Value | Purpose |
| --- | --- | --- |
| `telemetryTimeoutMs` | 2000 | abandon a hanging send |
| `maxQueueSize` | 1000 | bound memory |
| `dropPolicy` | `oldest` | which event to lose when full |
| `circuitBreakerThreshold` | 5 | consecutive failed flushes before opening |
| `circuitBreakerCooldownMs` | 30000 | how long to stop trying |
| `retryAttempts` | 1 | one retry per batch |
| `retryDelayMs` | 500 | delay before that retry |

`enqueue` is **synchronous**: it calls no I/O, awaits nothing and never throws.
The tests prove it returns `undefined` rather than a promise, is not an `async`
function, never touches the transport, and buffers 1000 items against a hanging
transport in under 100 ms.

Two deliberate choices worth knowing:

- **A failed batch is dropped, not requeued.** Requeueing would convert a backend
  outage into unbounded memory growth and endless retries of stale events. The
  handoff's position is that if the backend is down, telemetry is lost.
- **While the circuit is open, `enqueue` drops immediately** rather than buffering,
  so a long outage cannot accumulate a stale backlog.

`flush()` never rejects. A caller awaiting it is waiting for an attempt to finish,
not for a result it must handle.

---

## The SDK entry point

```ts
const telemetry = new Telemetry({
  mode: 'cloud',
  apiKey: process.env.NOTCHED_KEY,
  defaultRegistration: 'hash-only',
  registrationPolicy: { 'scraper-x': 'full', 'internal-pii-api': 'hash-only' },
  sdkVersion: '0.1.0',
})

const scraperFetch = telemetry.instrumentFetch({ provider: 'scraper-x', operation: 'extract' })

// One-off, with per-call validation:
await telemetry.wrap(fetch, url, init, {
  provider: 'scraper-x',
  operation: 'extract',
  rules: ['min-length:items:1'],
})
```

`Telemetry` decides two things and nothing more: **which registration applies** (per
call, then per-provider policy, then the configured default) and **whether to enqueue
a cloud POST** (`mode === "cloud"` and the resolved registration is not `local`). It
never signs.

Receipts written locally are unsigned drafts: `attestation: "self"`, `keyId: null`,
`serverSignature: null`. Claiming `"platform"` locally would assert an attestation
that has not happened yet — the backend sets that when it signs.

## Sentinels: non-hashes are never dressed as hashes

Two situations produce no faithful hash. Both put a **sentinel** in the hash slot and a
matching **`unvalidated:`** rule on the receipt:

| Situation | Hash slot | Rule | `validation.passed` |
| --- | --- | --- | --- |
| `FormData` / `Blob` / `ReadableStream` request body | `sentinel:unsupported-body-type` | `unvalidated:unsupported-body-type` | `null` |
| Response body over `maxResponseBytes` | `sentinel:oversize` | `unvalidated:oversize` | `null` |

The `sentinel:` prefix is load-bearing, not cosmetic. `sha256:unsupported-body-type`
would look like a malformed digest and invite a verifier to treat it as a corrupt
hash; `sentinel:` cannot be mistaken for one by any format check. `isHash()` returns
`false` and `isSentinel()` returns `true` for both — asserted in the tests.

Where a real rule *also* failed, `passed` stays `false`: that is a positive finding
about the response, and an unrelated gap does not make it untrue. What never happens is
`passed: true` while an `unvalidated:` rule is present.

## Response size cap

`maxResponseBytes` defaults to **1 MB** (D-010). The read stops as soon as the cap is
exceeded, rather than reading to the end and rejecting afterwards, so an oversized body
is never buffered.

The caller still receives every byte. Cancelling the `tee` branch telemetry was reading
leaves the caller's branch untouched — verified by a test that compares the full body
after an abandoned read. (One subtlety worth recording: a `tee` branch's `cancel()`
promise only settles once the *other* branch is cancelled, so awaiting it deadlocks.
It is fired and not awaited.)

---

## Spec amendments (decided)

Four deliberate deviations from the V1 handoff. The first was a bug that would
have broken every receipt; it was confirmed as an amendment on 2026-10-13.

### 1. Unicode NFC normalisation removed — the handoff contradicts RFC 8785

The handoff lists "Normalize unicode to NFC" as an RFC 8785 rule. RFC 8785 §3.1
states the opposite: JCS does not consider Unicode Normalization, and all
components **MUST** preserve string data "as is".

The official `unicode.json` vector confirms it: input `A` + U+030A must
canonicalize to the bytes `41 cc 8a`, not `c3 85` (U+00C5). An NFC-normalising
implementation **fails the official vector** and would disagree with every
third-party verifier.

Implemented: no normalisation. `A`+U+030A and U+00C5 remain distinct inputs with
distinct hashes. **Amendment accepted 2026-10-13.**

*If you later want NFC-insensitivity*, the fix is not to normalise inside the
canonicalizer. It is to normalise the payload once at a single boundary before
hashing, identically on both sides, and disclose it via `registration`. That
would break conformance with the official vector and with third-party verifiers,
so it is a product decision rather than a technical one.

### 2. `json-freeze` → `canonicalize`

`json-freeze` passes every conformance vector but **violates an RFC 8785 MUST**:
it silently serialises lone surrogates, which §3.2.2.2 requires to be fatal.
`canonicalize` is named in RFC 8785 Appendix G, has zero runtime dependencies, 18M
downloads/month, and counts both RFC 8785 authors as contributors. Full evidence
in [docs/canonicalization-decision.md](docs/canonicalization-decision.md).

### 3. Node 20+ → Node 22+

`canonicalize` v5 requires Node 22. Minor and easily reverted by pinning an older
release if you need Node 20.

### 4. `serverSignature` / `signedAt` are `string | null`, not `string`

Amended 2026-10-13. A locally-written receipt stores `null` in both fields, so
"absent" is explicit rather than a magic empty string. This does **not** change
any signed bytes: both fields are excluded from the signing payload regardless, so
`null`, `''` and a real signature all yield identical canonical output (asserted
in `receipt.test.ts`).

### 5. Two fields added to the signed payload: `schemaVersion` and `keyId`

Added 2026-10-13. Both sit **inside** the signed payload, so both changed the
signed bytes: the pinned sample-receipt digest moved from
`sha256:d42c30d9…f155b` to `sha256:5c5390bb…070c7`. That is the intended
consequence, and it is the reason `schemaVersion` exists at all — a schema change
that alters the signed field set must be visible to a verifier before it
canonicalizes anything. The ES6 number-serialization digest `be18b62b…8687` is
unchanged, confirming the canonicalizer itself did not move.

`schemaVersion: "1"` uses a **redacted-canonical `requestHash`** and a **raw-byte
`responseHash`**; that asymmetry is intentional and disclosed. `keyId` names the
signing key, which the server publishes — and never deletes — at `GET /v1/keys`.
Full field set, worked example and verification recipe:
[docs/receipt-schema.md](docs/receipt-schema.md).

`keyId` is typed **`string | null`** (`null` when unsigned), now consistent with
`serverSignature` and `signedAt`: all three mean "absent is `null`", never a
fabricated id. Being a type-only widening, it produced **no runtime byte change**,
so the pinned digest above is unaffected; the `null` versus `"k_0001"` byte
difference is asserted separately.

One consequence worth knowing before the backend is built: because `keyId` sits
inside the signed payload and only the signer knows which key it will use, the
SDK's draft is **not** byte-identical to the signed receipt. SDK and backend must
agree on every *observation* field; the signing-time key stamp is a deterministic,
verifier-reproducible step on top.

### 6. `latencyMs` added to `IngestEvent`

Added 2026-10-15. The receipt requires a `latencyMs`, and the event schema did not carry
one, so the backend had no way to reconstruct it — it would have had to invent a number or
store zero, and latency is a scorecard input. The SDK already had the value; it now sends
it. This changes the wire format, so an older SDK and a newer backend are mutually
incompatible on ingest.

---

## Known limitations

Deliberate V1 scope, recorded so they are not mistaken for oversights:

- **Secrets are detected by field name, not by value.** An API key pasted into a
  `description` field will not be redacted.
- **`access_token` and `refresh_token` are not covered** by the default body key
  list, which matches `token` exactly (not as a substring) so that `tokenCount`
  is not mistaken for a credential. Add provider-specific names via
  `RedactionPolicy.bodyKeys`.
- **URL *paths* are not redacted** — `/v1/keys/sk_live_abc` survives. Credentials
  in userinfo and sensitive query parameters *are* stripped.
- **Non-plain objects are rejected**, not coerced. A `Date`, `Map` or class
  instance reaching the canonicalizer throws rather than silently becoming a
  string or `{}`.
- **A local receipt is unsigned.** `attestation: "self"` stores `null` in
  `serverSignature` and `signedAt`. Use `isSignedReceipt()` rather than checking
  the fields directly; a signature without a signing time does not count as
  signed.
- **`non-empty` trims before checking.** Ruled 2026-10-13: a whitespace-only body
  (`'   '`) fails, while `' x '` passes. Called out because it is a deliberate
  departure from a literal reading of the handoff, not an oversight.
- **Rule paths cannot contain `:` or an escaped dot.** A JSON key literally named
  `a.b` is unreachable by path. Rare in practice, but it is a real limit.
- **`validation.passed: null` is not a pass.** Anything consuming a scorecard must
  exclude nulls; a naive `passed !== false` check would count unvalidated calls as
  good.
- **Interception buffers at most `maxResponseBytes` (1 MB by default).** Hashing the
  raw bytes requires reading them, so this cap is the only thing between a large
  response and unbounded memory. The cost: a response over the cap is **not covered by
  the receipt** — it carries `sentinel:oversize` and is never hashed. Raise the cap if
  that matters for a provider.
- **Request bodies that cannot be read without side effects get
  `sentinel:unsupported-body-type`** rather than a hash. A `FormData`, `Blob` or
  `ReadableStream` body is neither consumed nor guessed at: consuming it would disturb
  the caller's request, and inventing bytes would produce a receipt for a request that
  was never made. JSON POSTs carried as strings are fully covered, and `Request`-carried
  bodies are reached through a non-destructive clone.
- **A cloud-mode local draft records `tenantId: "tnt_local"`** unless you configure
  one. The real tenant is resolved by the backend from the API key, so the SDK may
  simply not know it. The local row is a draft; the authoritative receipt is the
  backend's.
- **A non-JSON request or response body gets no preview, even in `full` mode.**
  Structural redaction is impossible for it, and a raw preview could disclose a
  credential verbatim. The hash is unaffected: it covers the raw bytes.
- **A failed call is not captured.** If the underlying `fetch` rejects there is no
  status or response to record, so nothing is written. Provider-downtime evidence
  would need a schema change, since `statusCode` is required.
- **No crypto review yet.** The handoff makes an external review of the
  canonicalization and signing path a precondition for the first pilot. This
  decision record is written to hand to that reviewer.

---

## Backend: tenant isolation

Row-level security is enabled on `receipts` and `payloads` with a `tenant_isolation`
policy. The application connects as `notched_app`, a non-superuser role, because **a
table owner and a superuser both bypass RLS entirely** — running the isolation tests as
the migration user would make them pass vacuously. A test asserts the app role has
`rolsuper = false` and `rolbypassrls = false` for exactly that reason.

Three details decide whether RLS protects anything at all:

- **`SET LOCAL`, never `SET`.** `SET` is session-scoped, so on a pooled connection it
  survives the request that set it and is inherited by whichever request next checks
  out that connection — silently granting one tenant access to another's rows. The
  value is applied with `set_config('app.tenant_id', $1, true)` inside a transaction:
  the third argument *is* `SET LOCAL`, and the function form is used because a literal
  `SET LOCAL` cannot take a bind parameter, and interpolating one would be an injection
  hole. A test proves the setting does not survive its transaction.
- **`WITH CHECK`, not just `USING`.** `USING` filters reads; without `WITH CHECK` a
  tenant could still `INSERT` rows claiming to be someone else. Tested by attempting a
  forged cross-tenant insert.
- **Fails closed.** With `app.tenant_id` unset, `current_setting(..., true)` is NULL,
  the comparison is NULL, and the tenant sees **no rows** rather than every row.

`tenants` deliberately has no RLS: the API key middleware must resolve a tenant *before*
any tenant is known, so that lookup cannot be tenant-scoped. The consequence is that the
app role can read all `api_key_hash` values — necessary, and worth remembering.

### Schema notes

Two deliberate differences from the handoff's schema, both requested:

- `schema_version` and `key_id` are added — the handoff predates both fields.
- `server_signature` and `signed_at` are **nullable**. The handoff had `signed_at
  TIMESTAMPTZ NOT NULL DEFAULT now()`, but a receipt is inserted *before* it is signed
  and updated in place afterwards, so a NOT NULL default would record an ingest time as
  a signing time.

### Migrations

Numbered `.sql` files under `packages/backend/migrations/`, applied in filename order by
`src/db/migrate.ts` — no ORM, so the schema is reviewable in a diff. Each migration runs
in its own transaction (Postgres has transactional DDL, so a failure leaves nothing
behind), and **applied migrations are checksummed**: editing one that has already run is
refused, because the deployed database would never see the change and would silently
diverge from a freshly-migrated one.

### Testing against real Postgres

Backend tests run against `@electric-sql/pglite` — PostgreSQL compiled to WASM. A JS
emulator would let an RLS test pass without a policy ever running; PGlite enforces the
real thing, needs no server and works in CI. Migrations run as the owner, then the
session switches to `notched_app` so RLS actually bites.

Production is driven by `pg` through `poolFromPg`; it and the PGlite harness satisfy the
same `DbConnection` interface, so the `withTenant` code path under test is the one that
runs in production. The single place the drivers differ is documented in
`test/helpers/pg.ts`: `pg` sends a parameterless query over the simple protocol, which
permits several statements in one call — exactly what executing a migration file needs —
whereas PGlite's `query()` always uses the extended protocol, so the harness routes
parameterless calls to `exec()`.

---

## Backend: signing and ingest

### The signing key

`NOTCHED_SIGNING_KEY` is base64 of the 32-byte Ed25519 seed; `NOTCHED_SIGNING_KEY_ID`
defaults to `k_0001`. **The service refuses to start** when the key is missing, is not
base64, or does not decode to exactly 32 bytes (`openssl rand -base64 32`). It refuses in
development too: a dev server that boots without a key and then rejects every receipt
teaches the wrong thing about how the service works.

A key id already published under a *different* public key is also a hard stop. Overwriting
would break verification for every receipt already signed under that id; leaving the old
one in place would break every future receipt. Neither is recoverable, so the process
refuses rather than guessing.

The test fixture key lives in `test/helpers/keys.ts`, never in `src/`. A hard-coded seed in
shipped code is a known private key, and the failure mode — deploying with the test key
because it worked locally — is silent and catastrophic. Tests inject the key explicitly,
so nothing in `src/` needs a "test mode".

### What gets signed

`canonicalizeReceiptForSigning` from `@notched/protocol` produces the payload: RFC 8785
canonical JSON with `serverSignature` and `signedAt` **omitted entirely**, not set to null.
The backend does not reimplement it — a signer and a verifier that disagree produce
receipts that are valid and unverifiable. The signature covers the **UTF-8 bytes** of that
string, emitted as base64 with an `ed25519:` prefix.

### Ingest

One transaction per event, so a single malformed event rejects only itself rather than
losing a batch of 100. `accepted`/`rejected` count per event; a batch over 100 is a **413**
with `{ error: "batch_too_large", max, received }`.

**Idempotent on `receiptId`, first write wins.** A receipt is a signed artefact, so a
re-send must not be able to change what was signed — a test resends the same id with
different content and asserts the stored row is untouched.

One deviation from a plain `{ accepted, rejected, receipts }`: if *nothing* could be stored
and the cause was infrastructure rather than bad input, the response is **503**, not 200. A
200 would tell the SDK's queue the batch succeeded, so it would never retry and the
telemetry would be lost silently — the opposite of what the fail-open design is for.

### Verifying a receipt

`GET /v1/keys/current` and `GET /v1/keys` need no auth, deliberately: a verifier holds a
receipt and a public key and nothing else, so requiring a credential to fetch the key would
make offline verification impossible for exactly the third parties a receipt is meant to
convince. `/v1/keys/current` is served from memory, so a database outage does not stop
verification of a receipt you already hold.

`verifyReceipt` returns `false` for every failure and never throws, including for a
malformed signature: `@noble/ed25519` *throws* on a wrong-length signature rather than
returning false, and a verifier that crashes on a corrupt receipt is a denial-of-service
surface.

The assertion worth the most: a receipt is signed, stored, **read back out of Postgres**,
and verified against the published key. A column mapped to the wrong field, a `jsonb`
reshaped on the way out, or a timestamp losing precision through `timestamptz` would all
change the bytes the signature covers and fail that test. Timestamps are normalised to
millisecond precision on the way in for exactly that reason.

---

## Week 3c next

1. `GET /v1/receipts/:id` — tenant-scoped, never returns another tenant's data
2. `GET /v1/receipts/:id/verify` — public; re-canonicalises and checks the signature
3. Payload encryption: AES-256-GCM with a per-tenant key derived via HKDF
4. The 7-day purge job

Then Week 4: the `notched` CLI (`list`/`show`/`verify`/`scorecard`/`usage`) and the
standalone offline verifier.
