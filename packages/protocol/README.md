# @mstamp/protocol

The mstamp protocol: RFC 8785 canonicalization, tagged SHA-256 digests, redaction, response validation, and a fail-open telemetry queue. It wraps `fetch` to record what was sent and what came back — without altering either.

This is the protocol layer of [mstamp](https://github.com/samschotvanger-rgb/mstamp), a cryptographic evidence layer for external API calls made by AI agents. The signing service lives in the repository, not in this package.

## Install

```sh
npm install @mstamp/protocol
```

Node 22 or newer. ESM only.

**This package never signs anything.** Receipts it writes locally are unsigned (`attestation: "self"`, with `keyId`, `serverSignature` and `signedAt` all `null`). A signed receipt requires the backend, which holds the Ed25519 key.

## Usage

### Local mode — no server required

Records every call into a local SQLite store. Nothing leaves the process.

```js
import { Telemetry } from '@mstamp/protocol'

const telemetry = new Telemetry({
  mode: 'local',
  defaultRegistration: 'hash-only',
  sdkVersion: '0.1.0',
})

// The caller's request and response are untouched: the same Response comes back,
// still fully readable.
const observedFetch = telemetry.instrumentFetch({ provider: 'scraper-x', operation: 'extract' })

const response = await observedFetch('https://scraper-x.example/v1/items?page=1')
const items = await response.json()   // still readable — interception does not consume the body

telemetry.close()
```

Receipts land in `.mstamp/receipts.db` by default.

### Cloud mode — requires a running backend

```js
const telemetry = new Telemetry({
  mode: 'cloud',
  apiKey: process.env.MSTAMP_API_KEY,   // required
  endpoint: 'https://ingest.example.com', // required; there is no default
  defaultRegistration: 'hash-only',
  sdkVersion: '0.1.0',
})

await telemetry.flush()   // await the cloud POST; never rejects
telemetry.close()
```

There is deliberately no default `endpoint`. Where your telemetry goes is your decision, not a library default.

### Validation

Rules are supplied per call, or bound into the wrapper:

```js
const observedFetch = telemetry.instrumentFetch({
  provider: 'scraper-x',
  operation: 'extract',
  rules: ['non-empty', 'min-length:items:1'],
})
```

Built-in rules: `non-empty`, `has-field`, `min-length`, `freshness`, `numeric-range`, `no-duplicates`. A Zod-style schema (anything with `safeParse`) can be passed alongside them; both must pass. `validation.passed === null` means *not validated*, not *passed*.

## The two hashes are different on purpose

| | `requestHash` | `responseHash` |
| --- | --- | --- |
| Input | request body after redaction, then RFC 8785 canonicalization | response body exactly as received |
| Byte-faithful to the wire? | no | yes |

Redaction runs before hashing so a secret is never stored or transmitted, which means `requestHash` commits to a redacted *projection*. `responseHash` covers raw bytes, because hashing before parsing is the only way to cover a malformed or non-JSON response — exactly the failure this exists to catch.

When no faithful hash is possible (an unsupported body type, or a response over `maxResponseBytes`) the hash slot holds `sentinel:<reason>` rather than a fake digest. A `sentinel:` can never be mistaken for a `sha256:` digest.

## Verification

A third party needs only the receipt JSON and the Ed25519 public key named by its `keyId`. Remove `serverSignature` and `signedAt`, canonicalize the remainder per RFC 8785, and verify. Both the signer and any verifier must use `receiptSigningPayload()` rather than reimplementing that rule — a reimplementation that disagrees by one field makes every receipt unverifiable, silently.

## Links

- [Repository](https://github.com/samschotvanger-rgb/mstamp)
- [Receipt schema](https://github.com/samschotvanger-rgb/mstamp/blob/main/docs/receipt-schema.md) — the normative field set and verification recipe
- [Decisions that constrain the protocol](https://github.com/samschotvanger-rgb/mstamp/blob/main/docs/decisions-public.md)
- [Why this canonicalizer](https://github.com/samschotvanger-rgb/mstamp/blob/main/docs/canonicalization-decision.md)

## License

MIT
