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

**Week 1 of 6 complete.** Shared protocol package only; no backend, SDK or CLI
code yet, by design.

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
│       │   └── index.ts
│       └── test/
│           ├── canonical.test.ts    # 55 tests: conformance + guard
│           ├── hash.test.ts         # 12 tests: NIST vectors + crypto cross-check
│           ├── redact.test.ts       # 19 tests
│           ├── receipt.test.ts      # 16 tests
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

116 tests, all passing.

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
- **No crypto review yet.** The handoff makes an external review of the
  canonicalization and signing path a precondition for the first pilot. This
  decision record is written to hand to that reviewer.

---

## Week 2 next

1. `validate.ts` — Zod schemas plus the built-in rule library
2. `queue.ts` — fail-open async queue and circuit breaker
3. `local-db.ts` — SQLite receipt writer
4. `cloud.ts` — ingestion POST
5. Wire into the `Telemetry` class
6. Integration test: wrap a fake scraper returning `{"items": []}`, assert the
   receipt records `validation.passed = false`
