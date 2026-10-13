# Notched Receipt schema

**Current version:** `1`
**Signed by:** the Notched backend, Ed25519
**Verifiable:** offline, with only the receipt JSON and a public key

A Notched Receipt is a portable, offline-verifiable record of one external API
call. This document is the normative description of the V1 field set.

---

## The signed payload

The backend signs the **RFC 8785 canonical form** of the receipt *excluding* two
fields:

| Field | In the signed payload? | Why |
| --- | --- | --- |
| `serverSignature` | **no** | It is the signature. Including it would be circular. |
| `signedAt` | **no** | Assigned at signing time, so it cannot be an input to signing. |
| every other field | **yes** | Includes `schemaVersion`, `keyId`, and the reserved V2 fields. |

`receiptSigningPayload()` in `@notched/protocol` builds this object, and both the
signer and any verifier must call it rather than reimplementing the rule. A
reimplementation that disagrees by one field silently makes every receipt
unverifiable.

### Why `schemaVersion` and `keyId` are signed

Both are inside the payload because both would otherwise be forgeable in a way
that changes the meaning of the receipt:

- **`schemaVersion`** tells a verifier which field set to expect. If it were
  unsigned, an attacker could relabel a V1 receipt as some future version and
  have it interpreted under different rules.
- **`keyId`** tells a verifier which published public key to check against. If it
  were unsigned, an attacker could point a forged signature at whichever key they
  happened to hold.

---

## The requestHash / responseHash asymmetry — intentional and disclosed

**`schemaVersion` 1 uses a redacted-canonical `requestHash` and a raw-byte
`responseHash`. The asymmetry is intentional and disclosed.**

| | `requestHash` | `responseHash` |
| --- | --- | --- |
| Input | the request body **after redaction**, **after RFC 8785 canonicalization** | the response body **exactly as received** |
| Byte-faithful to the wire? | **No** | **Yes** |
| Rationale | redaction runs before hashing so that secrets are never stored or transmitted; canonicalization makes the same logical request hash identically regardless of key order or formatting | hashing before parsing is the only way to cover a malformed, truncated or non-JSON response, which is precisely the silent-failure class this product exists to catch |

Two consequences a user of a receipt must understand:

1. **`requestHash` is a commitment to a redacted *projection*, not to the bytes
   that left the process.** Because redaction replaces sensitive values with
   `<redacted>`, the hash covers the placeholder and never the real value. A
   receipt can therefore prove *"a request was made containing these non-secret
   fields"* — it cannot prove what was in the redacted positions.
2. **A third party cannot recompute `requestHash` from the wire**, because they
   do not have the unredacted original, and because canonicalization reorders
   keys and renormalises numbers even when no secret was present. `responseHash`
   *is* recomputable by anyone holding the response bytes.

This trade-off is the direct cost of the V1 privacy posture, in which "hash-only"
is the answer to field-level encryption. It is disclosed here, in the receipt's
`registration` field, and in the README's known limitations.

Hash format throughout: `"sha256:"` followed by 64 lowercase hex characters.

---

## `keyId` and key publication

`keyId` names the Ed25519 key that produced `serverSignature`, e.g. `"k_0001"`. It
is **`null`** when the receipt has no signature.

**`null` means "no signing key", exactly as for `serverSignature` and `signedAt`.**
A local, unsigned receipt has no key, so it must not carry a fabricated id. All
three fields share one rule: absent is `null`, never a magic empty string or a
stand-in value. `isSignedReceipt()` is the single check that ties them together.

### Filled in at signing time

`keyId` sits **inside** the signed payload, but only the signer knows which key it
will use. So the sequence is:

1. the SDK emits a draft with `keyId: null`;
2. the backend stamps the signing key;
3. the backend canonicalizes and signs.

A consequence worth being explicit about: **an SDK draft is deliberately not
byte-identical to the signed receipt**, because step 2 changes the signed bytes.
The drift guarantee is therefore narrower than it first appears — the SDK and the
backend must agree on every *observation* field (hashes, validation, status,
timing), and the signing-time completion is a deterministic,
verifier-reproducible step layered on top.

**The server publishes every public key it has ever used, past and present, at
`GET /v1/keys`, and never deletes one.** Key rotation therefore does not orphan
history: a receipt signed three years ago remains verifiable, and a verifier
simply looks up the `keyId` named inside the signed payload.

Never deleting a key is a deliberate choice. Removing a rotated or compromised
key would make every receipt it signed permanently unverifiable — destroying
exactly the evidence the product exists to preserve. The correct response to a
compromised key is to publish the compromise, not to erase the key.

---

## Field reference

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `"1"` | Signed. See above. |
| `receiptId` | `string` | `"rcpt_" + nanoid`. Idempotency key for ingestion and billing. |
| `tenantId` | `string` | `"tnt_" + nanoid`. A receipt always belongs to exactly one tenant. |
| `sellerId` | `string \| null` | `"slr_" + nanoid`. Always `null` in V1; no seller co-signing. |
| `provider` | `string` | e.g. `"scraper-x"` |
| `operation` | `string` | e.g. `"extract"` |
| `requestHash` | `string` | Redacted + canonicalized. See asymmetry above. |
| `responseHash` | `string` | Raw received bytes. See asymmetry above. |
| `statusCode` | `number` | HTTP status as observed by the SDK. |
| `latencyMs` | `number` | Wall-clock duration of the wrapped call. |
| `timestamp` | `string` | ISO 8601 UTC, SDK clock, when the call completed. |
| `registration` | `"full" \| "hash-only" \| "local"` | What was transmitted to the backend. |
| `attestation` | `"self" \| "platform" \| "bilateral" \| "notarized"` | Who vouches. See below. |
| `validation` | `object` | `{ passed, rules, errors }`. See below. |
| `anomaly` | `null` | Reserved for V2. Always `null` in V1, and signed as `null`. |
| `buyerOverride` | `null` | Reserved for V2. Always `null` in V1, and signed as `null`. |
| `sdkVersion` | `string` | Version of the SDK that produced the observation. |
| `keyId` | `string \| null` | Signed. Names the signing key; `null` when unsigned. See above. |
| `serverSignature` | `string \| null` | **Not signed.** `"ed25519:" + base64`. `null` when unsigned. |
| `signedAt` | `string \| null` | **Not signed.** ISO 8601 UTC. `null` when unsigned. |

### `validation`

```ts
{
  passed: boolean | null   // null = no validation could run (e.g. non-JSON body)
  rules: string[]          // rule ids applied, e.g. "min-length:items:1"
  errors: string[]         // human-readable failure descriptions
}
```

Validation runs **in the SDK**, never on the server. The server stores the verdict;
it does not compute one. A non-JSON response is hashed and marked
`unvalidated:non-json` with `passed: null` rather than failing the call.

### `attestation`

| Value | Meaning |
| --- | --- |
| `self` | Written locally by the buyer's SDK. Nobody countersigned it. `serverSignature` is `null`. |
| `platform` | Signed by the Notched backend. V1 cloud mode. |
| `bilateral` | Seller co-signed. V2. |
| `notarized` | Hardware-attested. V3+. |

### `registration`

| Value | Transmitted to backend | Cloud-signed |
| --- | --- | --- |
| `full` | hashes + redacted body preview | yes |
| `hash-only` | hashes + metadata only | yes |
| `local` | nothing | no |

---

## Reserved V2 fields

`anomaly` and `buyerOverride` are present in V1 and always `null`, **and they are
inside the signed payload**. They exist now so a V2 backend can begin populating
them without changing the V1 signed field set.

Note the consequence: a receipt carrying a non-null `anomaly` has different signed
bytes from a V1 receipt, so it must carry a different `schemaVersion`. That is the
mechanism by which V1 receipts stay verifiable.

---

## Worked example

```json
{
  "schemaVersion": "1",
  "receiptId": "rcpt_V1StGXR8Z5jdHi6B",
  "tenantId": "tnt_8f2b1c4d9e",
  "sellerId": null,
  "provider": "scraper-x",
  "operation": "extract",
  "requestHash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "responseHash": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "statusCode": 200,
  "latencyMs": 412,
  "timestamp": "2026-10-13T09:30:00.000Z",
  "registration": "hash-only",
  "attestation": "platform",
  "validation": {
    "passed": false,
    "rules": ["min-length:items:1"],
    "errors": ["items: expected at least 1, got 0"]
  },
  "anomaly": null,
  "buyerOverride": null,
  "sdkVersion": "0.1.0",
  "keyId": "k_0001",
  "serverSignature": "ed25519:U0VMRi1TSUdOQVRVUkU=",
  "signedAt": "2026-10-13T09:30:01.000Z"
}
```

Its signing payload (`schemaVersion` `"1"`, `serverSignature` and `signedAt`
removed, RFC 8785 canonicalized) hashes to:

```
sha256:5c5390bb0a90ad90d7e5a9226edc398d3a2cdc84df2e28b8885ee1a5c04070c7
```

This digest is pinned as a tripwire in `test/receipt.test.ts`. If it changes, the
signed field set changed and every previously-issued receipt became
unverifiable — a protocol-version decision, never a side effect.

---

## Verification recipe

To verify a receipt offline you need: the receipt JSON, and the public key named
by its `keyId` (from `GET /v1/keys`).

1. Read `schemaVersion` and confirm you know that field set.
2. Read `keyId`. If it is `null` the receipt is **unsigned**: there is no signature
   to check and the only claim it supports is `attestation: "self"`. Stop here.
3. Remove `serverSignature` and `signedAt`.
4. Canonicalize the remainder per RFC 8785 — UTF-8, no BOM, sorted keys, no
   whitespace, ECMAScript number formatting, **and no Unicode normalization**.
5. Verify the Ed25519 signature over those bytes using the key named by `keyId`.

Step 4 is the step that goes wrong. Any deviation in number formatting, key
ordering or Unicode handling produces different bytes and a false negative. Use
the IETF conformance vectors vendored at
`packages/protocol/test/vectors/rfc8785.ts` to check an independent
implementation before trusting it.
