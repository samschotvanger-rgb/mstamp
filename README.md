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

**Weeks 1, 2a and 2b-i complete.** Shared protocol package only; no backend, SDK or
CLI code yet, by design. 2b-i added `fetch` interception and local SQLite storage;
the cloud transport and the `Telemetry` class are still to come.

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
│       │   └── index.ts
│       └── test/
│           ├── canonical.test.ts    # 55 tests: conformance + guard
│           ├── hash.test.ts         # 12 tests: NIST vectors + crypto cross-check
│           ├── redact.test.ts       # 19 tests
│           ├── receipt.test.ts      # 16 tests
│           ├── validate.test.ts     # 68 tests: every rule, pass/fail/missing
│           ├── queue.test.ts        # 29 tests: drop policy, breaker, retry timing
│           ├── intercept.test.ts    # 26 tests: pass-through, hashes, fail-open
│           ├── local-db.test.ts     # 25 tests: round-trip, concurrency, lifecycle
│           ├── bakeoff.test.ts      # 5 tests: the library decision
│           └── vectors/rfc8785.ts   # vendored IETF conformance corpus
├── scripts/
│   └── test-canonicalization.ts     # SDK vs backend vs independent verifier
├── docs/
│   ├── canonicalization-decision.md
│   └── receipt-schema.md            # normative V1 field set + verification recipe
└── README.md
```

`packages/sdk`, `packages/cli` and `packages/backend` do not exist yet. All
shared logic goes in `packages/protocol` so the signer and the verifier cannot
drift apart.

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

264 tests, all passing.

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
- **Interception buffers the whole response body in memory**, because hashing the
  raw bytes requires reading all of them. A very large response therefore costs
  memory proportional to its size. Hashing the raw bytes and leaving the caller's
  stream untouched are in tension; the tee from `Response.clone()` is the only way
  to have both.
- **Request bodies that cannot be read without side effects get
  `requestBodyHash: null`.** A `FormData`, `Blob` or `ReadableStream` body is
  neither consumed nor guessed at: consuming it would disturb the caller's request,
  and inventing bytes would produce a receipt for a request that was never made.
  `Receipt.requestHash` is a required `string`, so those requests cannot currently
  produce a V1 receipt. JSON POSTs carried as strings are fully covered, and
  `Request`-carried bodies are reached through a non-destructive clone.
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

## Week 2b-ii next

1. `cloud.ts` — ingestion POST, consuming `TelemetryQueue` as its transport
2. `telemetry.ts` — wire interception, redaction, hashing, validation, local storage
   and the queue together into the `Telemetry` class
3. Integration test: wrap a fake scraper returning `{"items": []}`, assert the
   receipt records `validation.passed = false`
4. Fail-open test: kill the backend mid-call, assert the primary fetch still
   succeeds and the process exits cleanly
