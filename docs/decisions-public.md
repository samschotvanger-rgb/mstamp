# Public decision record

A subset of mstamp's decision log, published because these entries constrain the
wire format, the hashes, or the privacy posture. Anyone reading or reimplementing
the protocol needs them to get the same bytes and the same verdicts.

**Entry numbers match the full log exactly.** A code comment citing `D-015`
resolves to the same decision in both, so the citation is stable even though most
of the surrounding entries are not published here. The full log is append-only;
the gaps in the numbering below are entries that concern commercial strategy or
internal project administration and are deliberately not public.

An entry is never edited in place. To reverse one, a new entry is written that
supersedes it and links back.

---

## D-001 — No Unicode normalization in canonicalization

RFC 8785 §3.1 forbids it:

> Although the Unicode standard offers the possibility of rearranging certain
> character sequences, referred to as "Unicode Normalization", JCS-compliant
> string processing does not take this into consideration. That is, all
> components involved in a scheme depending on JCS MUST preserve Unicode string
> data "as is".

The official `unicode.json` vector settles it: the input `A` + `U+030A`
(COMBINING RING ABOVE) must serialize to the bytes `41 cc 8a`, not to the
`c3 85` that NFC normalization would produce.

**Consequence:** `A` + `U+030A` and `U+00C5` are permanently distinct inputs with
distinct hashes. A verifier that normalizes will disagree with every mstamp hash
and fail the official vector. A regression test enforces this.

## D-002 — `responseHash` covers the raw bytes

SHA-256 of the response bytes exactly as received. No decoding, no parsing, no
normalization.

**Rationale:** decoding first would collapse invalid UTF-8 to `U+FFFD`, so two
different broken responses would hash identically — and a malformed response is
precisely the failure class this protocol exists to detect.

## D-003 — `requestHash` covers a redacted, canonical projection

SHA-256 of the RFC 8785 canonical form of the request body *after* redaction. It
is deliberately **not** byte-faithful to what left the process.

**Rationale:** redaction has to run before hashing, because redacting the
outgoing request would send the string `<redacted>` to the provider.
Canonicalization is then required for logical identity, since the same logical
body can be serialized many ways.

**Consequence:** a receipt proves "a request was made containing these non-secret
fields". It does not prove the exact bytes the provider received. This asymmetry
between `requestHash` and `responseHash` is intentional and disclosed in
[receipt-schema.md](receipt-schema.md).

## D-004 — Unsigned receipts use `null`, never empty strings

`serverSignature`, `signedAt` and `keyId` are typed `string | null`. A local,
unsigned receipt sets all three to `null`.

**Consequence:** the three fields are stripped entirely from the signing payload,
so `null`, `''` and a real signature all yield byte-identical canonical output. A
verifier must test `keyId === null` to detect an unsigned receipt rather than
truthiness.

## D-005 — Local receipts are terminal

A locally-written receipt stays `attestation: "self"` permanently. It is never
re-signed.

**Rationale:** re-signing an old observation after the fact would let the signer
backdate a claim, which is exactly the guarantee a receipt is supposed to
provide. Cloud backfill instead writes a *new* receipt that references the local
one.

## D-006 — `schemaVersion` and `keyId` are inside the signed payload

Both are covered by the signature rather than transported alongside it.

**Rationale:** `schemaVersion: "1"` lets a later schema add populated `anomaly`
and `buyerOverride` fields without invalidating V1 signatures. `keyId` lets the
signing key rotate without orphaning receipts signed under the previous key.

**Consequence:** changing the signed field set changes every receipt's signing
payload. That is a protocol-version decision, never a refactor.

## D-007 — One signing key at a time, and published keys are never deleted

A single Ed25519 key signs. `keyId` identifies which key signed a given receipt.
`GET /v1/keys` publishes every public key ever used.

**Consequence:** deleting a retired key would make every receipt it signed
permanently unverifiable, so keys are append-only.

**Known limitation:** signatures prove authorship, not time. An attacker holding
the signing key can forge a receipt with any timestamp. Timestamping (RFC 3161)
is the intended mitigation and is not implemented.

## D-008 — The `non-empty` rule trims whitespace

`"   "` fails `non-empty`. `" x "` passes.

**Rationale:** a whitespace-only body is exactly the silent failure this product
exists to catch, so it must not satisfy a rule whose name promises content.

## D-009 — Rule paths have no escape syntax

Rule paths separate keys with `.` and parameters with `:`. There is no escaping,
so a JSON key literally named `a.b` cannot be addressed by a validation rule.

**Consequence:** a documented limitation rather than a bug. Escape syntax would be
added only if a real consumer needs it.

## D-010 — `full` registration stores the raw body, encrypted, for 7 days

Under `full` registration the response body is stored verbatim — redaction is
*not* applied to the stored copy, because the point is to let a buyer reveal the
exact bytes in a dispute. No truncation: a body over 1 MB is skipped and marked
rather than stored partially.

**Consequence:** stored previews are the only near-verbatim caller data mstamp
holds, so they are encrypted with AES-256-GCM under a per-tenant key and expire.

## D-011 — Validation results are buyer-private by default

A validation verdict is not published in any shared scorecard and is not shown to
the provider unless the buyer opts in.

**Rationale:** two buyers with different declared rules reach different verdicts
on the same response, so verdicts are not comparable across buyers and must not be
aggregated.

## D-013 — `IngestEvent` carries `latencyMs`

`Receipt.latencyMs` is required and is an input to scoring, but the ingest event
did not carry one, so the backend could not reconstruct it — it would have had to
write zero or invent a number, and a fabricated latency corrupts every figure
built on it. The client already holds the real value.

**Consequence: a breaking wire-format change.** A client and backend built on
opposite sides of this change are mutually incompatible on ingest. Accepted
because no client had been distributed; after that point, wire-format changes
require version negotiation.

## D-014 — `tenantId` defaults to `tnt_local`

A locally-written receipt needs a tenant id, and a local-only deployment has no
backend to supply one, so the client defaults to the literal `tnt_local`.

**Consequence:** in cloud mode a *local draft* can name a tenant that does not
exist. That is acceptable — the draft is superseded by the backend's
authoritative receipt, which resolves the real tenant from the API key — but it
matters if you read the local database directly.

## D-015 — Response bodies are capped at 1 MB

`maxResponseBytes` defaults to `1_048_576`. Hashing raw bytes means reading all of
them, so without a cap interception would buffer an unbounded response on the
caller's behalf.

Over the cap the read stops, the hash slot carries `sentinel:oversize`, and the
response is **not hashed**.

**Consequence:** **a response larger than the cap is not covered by the
receipt.** That is the accepted cost of the bound. Raise the cap for a provider
where it matters. The caller always still receives every byte.

## D-019 — There is no default cloud endpoint

`endpoint` has no default value and is required in cloud mode, validated at
construction alongside `apiKey`. It is unused in local mode, where nothing is
posted.

**Rationale:** a default hostname baked into the library would send every
caller's telemetry to a domain the library author controls and the caller does
not. "Where does my data go" is a decision for the caller to make explicitly, and
a library that answers it silently has made a disclosure decision on the caller's
behalf. An earlier revision shipped `DEFAULT_ENDPOINT = "https://api.mstamp.dev"`;
that constant was removed before any release.

**Consequence:** upgrading from that revision is a breaking change — cloud-mode
configurations must now pass `endpoint`. The failure is a construction-time throw
naming the missing field, not a silent post to the wrong host.
