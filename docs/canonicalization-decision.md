# Canonicalization decision record

**Status:** decided (2026-10-12)
**Selected implementation:** [`canonicalize`](https://www.npmjs.com/package/canonicalize) v5.1.0
**Rejected:** `json-freeze` v1.0.0 (named by the original spec), `json-canonicalize` v3.0.1

This record exists because a canonicalization bug invalidates every receipt ever
issued, silently and irreversibly. The original spec names `json-freeze`; that
instruction was treated as a hypothesis and tested rather than followed.

Reproduce with:

```sh
pnpm --filter @mstamp/protocol exec vitest run test/bakeoff.test.ts
```

## 1. Conformance (asserted)

All three candidates are **byte-perfect RFC 8785** on valid I-JSON. The original spec's
suspicion of `json-freeze` was, on this axis, unfounded.

| Corpus | `canonicalize` | `json-canonicalize` | `json-freeze` |
| --- | --- | --- | --- |
| IETF `testdata/` vectors (6 files) | 6/6 | 6/6 | 6/6 |
| RFC 8785 Appendix B numbers (24) | 24/24 | 24/24 | 24/24 |
| ES6 number conformance hash, 1000 lines | pass | pass | pass |

The ES6 result is the strongest single check: the generated
`<ieee-hex>,<expected>\n` file hashes to the value published in the IETF
project's `testdata/README.md`:

```
be18b62b6f69cdab33a7e0dae0d9cfa869fda80ddc712221570f9f40a5878687
```

That covers 166 curated edge cases (zero, negative zero, both subnormal
extremes, `1e21`/`1e-7` notation thresholds, round-half-to-even) followed by 834
consecutive subnormals.

## 2. Error semantics (measured, deciding)

RFC 8785 requires some inputs to be rejected outright. Measured behaviour:

| Input | RFC 8785 | `canonicalize` | `json-canonicalize` | `json-freeze` |
| --- | --- | --- | --- | --- |
| `NaN`, `Infinity`, `-Infinity` | reject | rejects | rejects | rejects |
| `1n` (BigInt) | reject | rejects | rejects | rejects |
| circular reference | reject | rejects | rejects | rejects |
| lone surrogate in string | **reject** | **rejects** | **accepts** | **accepts** |
| lone surrogate in key | **reject** | **rejects** | **accepts** | **accepts** |
| `{ a: undefined }` | reject | emits `{}` | emits `{}` | emits `{}` |
| `{ a: () => 1 }` | reject | emits `{}` | emits `{"a":undefined}` | rejects |
| `{ a: Symbol() }` | reject | emits `{}` | emits `{"a":undefined}` | rejects |

Two findings drive the decision:

1. **`json-freeze` violates an RFC 8785 MUST.** §3.2.2.2 requires lone
   surrogates to "cause a compliant JCS implementation to terminate with an
   appropriate error". It silently serialises them, producing invalid UTF-8 on
   the wire and a hash that another implementation may compute differently.

2. **No candidate rejects `undefined`.** All three silently drop the property.
   This is why `packages/protocol/src/canonical.ts` carries its own explicit
   I-JSON guard rather than trusting the library. Without it, a payload
   containing `undefined` would be hashed in rewritten form, and the receipt
   would attest to a request the buyer never made.

## 3. Supply chain and maintenance

| | `canonicalize` | `json-freeze` |
| --- | --- | --- |
| Downloads/month | 18,028,164 | 1,316 |
| Runtime dependencies | **0** | 0 |
| Licence | Apache-2.0 | MIT |
| Contributors | includes **both RFC 8785 authors** | single maintainer |
| Releases | multi-year history | one release (1.0.0) |
| Commits since first publish | ongoing | none |
| Stars | — | 6 |

`canonicalize` is named in **RFC 8785 Appendix G** as a verified-compatible
JavaScript implementation, and its contributor list includes Anders Rundgren
(RFC 8785 lead author) and Samuel Erdtman (co-author). `json-freeze` is a
single-maintainer package with one release and no subsequent commits — not
"maintained" by any reasonable reading.

## 4. Decision

Use `canonicalize`, wrapped in the I-JSON guard in `src/canonical.ts`.

The runner-up implementations are retained as **devDependencies** so this
comparison stays reproducible for the independent cryptographic review that is
required before any production use. They are never shipped to consumers.

## 5. Consequences

- `src/canonical.ts` rejects non-I-JSON input **before** delegating. It never
  transforms, so valid input is byte-identical to calling `canonicalize`
  directly (asserted in `canonical.test.ts`, "is byte-neutral").
- A pinned digest of the sample receipt's signing payload is asserted in
  `receipt.test.ts`. If that value ever changes, the signed bytes changed, which
  means previously-issued receipts became unverifiable. Treat a change as a
  protocol-version decision, never a side effect.
- Node floor is **22.0.0** — `canonicalize` v5 requires it. The original spec said
  "Node.js 20+"; this is a deliberate, minor deviation.

## 6. Spec amendment: the original spec's NFC rule was wrong (accepted 2026-10-13)

The original spec lists, as an RFC 8785 rule:

> Normalize unicode to NFC

**RFC 8785 §3.1 says the opposite:**

> Although the Unicode standard offers the possibility of rearranging certain
> character sequences, referred to as "Unicode Normalization", JCS-compliant
> string processing does not take this into consideration. That is, all
> components involved in a scheme depending on JCS MUST preserve Unicode string
> data "as is".

The official `unicode.json` vector proves it. Input is `A` + U+030A
(COMBINING RING ABOVE); the expected output bytes are:

```
7b 22 55 6e 6e 6f 72 6d 61 6c 69 7a 65 64 20 55 6e 69 63 6f 64 65 22 3a 22 41 cc 8a 22 7d
                                                                          ^^^^^
                                                                     A + U+030A, unnormalised
```

An NFC-normalising implementation would emit `c3 85` (U+00C5) instead and fail
the vector.

**Implemented:** no normalisation. `A`+U+030A and U+00C5 are treated as distinct
inputs with distinct hashes.

**Status: amendment confirmed by the project owner on 2026-10-13.** The original spec's
"Normalize unicode to NFC" rule is struck from the canonicalization spec.

## 7. Related schema amendment: unsigned fields

`Receipt.serverSignature` and `Receipt.signedAt` were changed from `string` to
`string | null` on 2026-10-13, so an unsigned local receipt stores `null` rather
than a magic empty string.

This has **no effect on canonicalization or on any signature**. Both fields are
excluded from the signing payload, so `null`, `''` and a real signature all yield
byte-identical canonical output — asserted in `receipt.test.ts` under "ignores the
two unsigned fields whatever their value". The pinned sample-receipt digest is
therefore unchanged by this amendment.
