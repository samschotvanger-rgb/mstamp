/**
 * Vendored RFC 8785 (JSON Canonicalization Scheme) conformance vectors.
 *
 * Source: https://github.com/cyberphone/json-canonicalization (Apache-2.0),
 * maintained by the RFC 8785 authors. Files under `testdata/`.
 *
 * Why vendor instead of fetching at test time:
 *   - CI must not depend on network access or on a third-party repo's HEAD.
 *   - These are conformance fixtures. If they change upstream, we want a
 *     deliberate, reviewable commit here - not a silently different test run.
 *
 * Why expected output is stored as hex:
 *   `values.json` and `weird.json` contain C0 control characters, U+007F,
 *   U+0080 and an astral-plane emoji. Comparing those as displayed strings is
 *   unreliable (editors, terminals and transports all mangle them). The
 *   upstream project ships `testdata/outhex/` for exactly this reason; we do
 *   the same. Hex is copied verbatim from upstream and normalised in code.
 */

/** Normalise a verbatim, space-separated upstream hex dump for comparison. */
export function normalizeHex(hex: string): string {
  return hex.replace(/\s+/g, '').toLowerCase()
}

export type OfficialVector = {
  /** File name in upstream `testdata/`. */
  readonly name: string
  /** Raw upstream input file text. Parsed with JSON.parse at test time. */
  readonly inputJson: string
  /** Raw upstream `testdata/outhex/<name>.txt` contents. */
  readonly expectedHex: string
}

const ARRAYS_INPUT = `
[
  56,
  {
    "d": true,
    "10": null,
    "1": [ ]
  }
]
`

const FRENCH_INPUT = `
{
  "peach": "This sorting order",
  "péché": "is wrong according to French",
  "pêche": "but canonicalization MUST",
  "sin":   "ignore locale"
}
`

const STRUCTURES_INPUT = `
{
  "1": {"f": {"f": "hi","F": 5} ,"\\n": 56.0},
  "10": { },
  "": "empty",
  "a": { },
  "111": [ {"e": "yes","E": "no" } ],
  "A": { }
}
`

const UNICODE_INPUT = `
{
  "Unnormalized Unicode":"A\\u030a"
}
`

const VALUES_INPUT = `
{
  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
  "string": "\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\"\\/",
  "literals": [null, true, false]
}
`

const WEIRD_INPUT = `
{
  "\\u20ac": "Euro Sign",
  "\\r": "Carriage Return",
  "\\u000a": "Newline",
  "1": "One",
  "\\u0080": "Control\\u007f",
  "\\ud83d\\ude02": "Smiley",
  "\\u00f6": "Latin Small Letter O With Diaeresis",
  "\\ufb33": "Hebrew Letter Dalet With Dagesh",
  "</script>": "Browser Challenge"
}
`

export const OFFICIAL_VECTORS: readonly OfficialVector[] = [
  {
    name: 'arrays.json',
    inputJson: ARRAYS_INPUT,
    expectedHex: '5b 35 36 2c 7b 22 31 22 3a 5b 5d 2c 22 31 30 22 3a 6e 75 6c 6c 2c 22 64 22 3a 74 72 75 65 7d 5d',
  },
  {
    name: 'french.json',
    inputJson: FRENCH_INPUT,
    expectedHex:
      '7b 22 70 65 61 63 68 22 3a 22 54 68 69 73 20 73 6f 72 74 69 6e 67 20 6f 72 64 65 72 22 2c 22 70 ' +
      'c3 a9 63 68 c3 a9 22 3a 22 69 73 20 77 72 6f 6e 67 20 61 63 63 6f 72 64 69 6e 67 20 74 6f 20 46 ' +
      '72 65 6e 63 68 22 2c 22 70 c3 aa 63 68 65 22 3a 22 62 75 74 20 63 61 6e 6f 6e 69 63 61 6c 69 7a ' +
      '61 74 69 6f 6e 20 4d 55 53 54 22 2c 22 73 69 6e 22 3a 22 69 67 6e 6f 72 65 20 6c 6f 63 61 6c 65 ' +
      '22 7d',
  },
  {
    name: 'structures.json',
    inputJson: STRUCTURES_INPUT,
    expectedHex:
      '7b 22 22 3a 22 65 6d 70 74 79 22 2c 22 31 22 3a 7b 22 5c 6e 22 3a 35 36 2c 22 66 22 3a 7b 22 46 ' +
      '22 3a 35 2c 22 66 22 3a 22 68 69 22 7d 7d 2c 22 31 30 22 3a 7b 7d 2c 22 31 31 31 22 3a 5b 7b 22 ' +
      '45 22 3a 22 6e 6f 22 2c 22 65 22 3a 22 79 65 73 22 7d 5d 2c 22 41 22 3a 7b 7d 2c 22 61 22 3a 7b ' +
      '7d 7d',
  },
  {
    // The whole point of this vector: JCS does NOT normalise Unicode.
    // "A" + U+030A must stay two code points. Expected bytes end `41 cc 8a`,
    // i.e. "A" + U+030A in UTF-8 - NOT U+00C5 (which would be `c3 85`).
    name: 'unicode.json',
    inputJson: UNICODE_INPUT,
    expectedHex: '7b 22 55 6e 6e 6f 72 6d 61 6c 69 7a 65 64 20 55 6e 69 63 6f 64 65 22 3a 22 41 cc 8a 22 7d',
  },
  {
    name: 'values.json',
    inputJson: VALUES_INPUT,
    expectedHex:
      '7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72 75 65 2c 66 61 6c 73 65 5d 2c 22 6e ' +
      '75 6d 62 65 72 73 22 3a 5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31 65 2b 33 30 ' +
      '2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37 5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 ' +
      '5c 75 30 30 30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d',
  },
  {
    // Contains the UTF-16 vs code-point sorting trap: the emoji U+1F602 is
    // encoded as the surrogate pair D83D DE02, so in UTF-16 code-unit order it
    // sorts BEFORE U+FB33 - even though its code point is larger. An
    // implementation that sorts by code point produces the wrong bytes here.
    name: 'weird.json',
    inputJson: WEIRD_INPUT,
    expectedHex:
      '7b 22 5c 6e 22 3a 22 4e 65 77 6c 69 6e 65 22 2c 22 5c 72 22 3a 22 43 61 72 72 69 61 67 65 20 52 ' +
      '65 74 75 72 6e 22 2c 22 31 22 3a 22 4f 6e 65 22 2c 22 3c 2f 73 63 72 69 70 74 3e 22 3a 22 42 72 ' +
      '6f 77 73 65 72 20 43 68 61 6c 6c 65 6e 67 65 22 2c 22 c2 80 22 3a 22 43 6f 6e 74 72 6f 6c 7f 22 ' +
      '2c 22 c3 b6 22 3a 22 4c 61 74 69 6e 20 53 6d 61 6c 6c 20 4c 65 74 74 65 72 20 4f 20 57 69 74 68 ' +
      '20 44 69 61 65 72 65 73 69 73 22 2c 22 e2 82 ac 22 3a 22 45 75 72 6f 20 53 69 67 6e 22 2c 22 f0 ' +
      '9f 98 82 22 3a 22 53 6d 69 6c 65 79 22 2c 22 ef ac b3 22 3a 22 48 65 62 72 65 77 20 4c 65 74 74 ' +
      '65 72 20 44 61 6c 65 74 20 57 69 74 68 20 44 61 67 65 73 68 22 7d',
  },
]

/**
 * Build the IEEE-754 double whose bit pattern is the given 16-hex-digit string.
 * Constructing numbers from their bits (rather than from a JS literal) is the
 * only way to be certain the test exercises the intended value: JS literal
 * parsing would silently round, hiding exactly the bugs we want to catch.
 */
export function f64FromBits(bitsHex: string): number {
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setBigUint64(0, BigInt(`0x${bitsHex}`), false)
  return view.getFloat64(0, false)
}

/**
 * RFC 8785 Appendix B, "Number Serialization Samples".
 * Every row of Table 1 except the two non-JSON rows (NaN and Infinity), which
 * are asserted separately as must-throw inputs.
 */
export const APPENDIX_B_NUMBERS: readonly { readonly bits: string; readonly expected: string; readonly comment: string }[] = [
  { bits: '0000000000000000', expected: '0', comment: 'Zero' },
  { bits: '8000000000000000', expected: '0', comment: 'Minus zero serialises as 0' },
  { bits: '0000000000000001', expected: '5e-324', comment: 'Min positive subnormal' },
  { bits: '8000000000000001', expected: '-5e-324', comment: 'Min negative subnormal' },
  { bits: '7fefffffffffffff', expected: '1.7976931348623157e+308', comment: 'Max positive number' },
  { bits: 'ffefffffffffffff', expected: '-1.7976931348623157e+308', comment: 'Max negative number' },
  { bits: '4340000000000000', expected: '9007199254740992', comment: 'Max positive integer' },
  { bits: 'c340000000000000', expected: '-9007199254740992', comment: 'Max negative integer' },
  { bits: '4430000000000000', expected: '295147905179352830000', comment: '~2**68, beyond integer precision' },
  { bits: '44b52d02c7e14af5', expected: '9.999999999999997e+22', comment: '' },
  { bits: '44b52d02c7e14af6', expected: '1e+23', comment: '' },
  { bits: '44b52d02c7e14af7', expected: '1.0000000000000001e+23', comment: '' },
  { bits: '444b1ae4d6e2ef4e', expected: '999999999999999700000', comment: '' },
  { bits: '444b1ae4d6e2ef4f', expected: '999999999999999900000', comment: '' },
  { bits: '444b1ae4d6e2ef50', expected: '1e+21', comment: 'Exponent-notation threshold' },
  { bits: '3eb0c6f7a0b5ed8c', expected: '9.999999999999997e-7', comment: '' },
  { bits: '3eb0c6f7a0b5ed8d', expected: '0.000001', comment: 'Decimal-notation threshold' },
  { bits: '41b3de4355555553', expected: '333333333.3333332', comment: '' },
  { bits: '41b3de4355555554', expected: '333333333.33333325', comment: '' },
  { bits: '41b3de4355555555', expected: '333333333.3333333', comment: '' },
  { bits: '41b3de4355555556', expected: '333333333.3333334', comment: '' },
  { bits: '41b3de4355555557', expected: '333333333.33333343', comment: '' },
  { bits: 'becbf647612f3696', expected: '-0.0000033333333333333333', comment: '' },
  { bits: '43143ff3c1cb0959', expected: '1424953923781206.2', comment: 'Round half to even' },
]

/** Non-JSON IEEE-754 values that a conformant implementation MUST reject. */
export const APPENDIX_B_NON_JSON_BITS: readonly { readonly bits: string; readonly comment: string }[] = [
  { bits: '7fffffffffffffff', comment: 'NaN' },
  { bits: '7ff0000000000000', comment: 'Infinity' },
  { bits: 'fff0000000000000', comment: '-Infinity' },
]

/**
 * The deterministic ES6 number-serialization test sequence from upstream
 * `testdata/README.md`. The first 166 values are curated edge cases; the next
 * 2000 are consecutive subnormals starting at 0x0010000000000000.
 *
 * Transcribing these exactly is safe because the sequence is validated by a
 * published SHA-256 over the generated file: if one constant were mistyped, the
 * checksum test would fail.
 */
export const ES6_STATIC_U64S: readonly bigint[] = [
  0x0000000000000000n, 0x8000000000000000n, 0x0000000000000001n, 0x8000000000000001n,
  0xc46696695dbd1cc3n, 0xc43211ede4974a35n, 0xc3fce97ca0f21056n, 0xc3c7213080c1a6acn,
  0xc39280f39a348556n, 0xc35d9b1f5d20d557n, 0xc327af4c4a80aaacn, 0xc2f2f2a36ecd5556n,
  0xc2be51057e155558n, 0xc28840d131aaaaacn, 0xc253670dc1555557n, 0xc21f0b4935555557n,
  0xc1e8d5d42aaaaaacn, 0xc1b3de4355555556n, 0xc17fca0555555556n, 0xc1496e6aaaaaaaabn,
  0xc114585555555555n, 0xc0e046aaaaaaaaabn, 0xc0aa0aaaaaaaaaaan, 0xc074d55555555555n,
  0xc040aaaaaaaaaaabn, 0xc00aaaaaaaaaaaabn, 0xbfd5555555555555n, 0xbfa1111111111111n,
  0xbf6b4e81b4e81b4fn, 0xbf35d867c3ece2a5n, 0xbf0179ec9cbd821en, 0xbecbf647612f3696n,
  0xbe965e9f80f29212n, 0xbe61e54c672874dbn, 0xbe2ca213d840baf8n, 0xbdf6e80fe033c8c6n,
  0xbdc2533fe68fd3d2n, 0xbd8d51ffd74c861cn, 0xbd5774ccac3d3817n, 0xbd22c3d6f030f9acn,
  0xbcee0624b3818f79n, 0xbcb804ea293472c7n, 0xbc833721ba905bd3n, 0xbc4ebe9c5db3c61en,
  0xbc18987d17c304e5n, 0xbbe3ad30dfcf371dn, 0xbbaf7b816618582fn, 0xbb792f9ab81379bfn,
  0xbb442615600f9499n, 0xbb101e77800c76e1n, 0xbad9ca58cce0be35n, 0xbaa4a1e0a3e6fe90n,
  0xba708180831f320dn, 0xba3a68cd9e985016n, 0x446696695dbd1cc3n, 0x443211ede4974a35n,
  0x43fce97ca0f21056n, 0x43c7213080c1a6acn, 0x439280f39a348556n, 0x435d9b1f5d20d557n,
  0x4327af4c4a80aaacn, 0x42f2f2a36ecd5556n, 0x42be51057e155558n, 0x428840d131aaaaacn,
  0x4253670dc1555557n, 0x421f0b4935555557n, 0x41e8d5d42aaaaaacn, 0x41b3de4355555556n,
  0x417fca0555555556n, 0x41496e6aaaaaaaabn, 0x4114585555555555n, 0x40e046aaaaaaaaabn,
  0x40aa0aaaaaaaaaaan, 0x4074d55555555555n, 0x4040aaaaaaaaaaabn, 0x400aaaaaaaaaaaabn,
  0x3fd5555555555555n, 0x3fa1111111111111n, 0x3f6b4e81b4e81b4fn, 0x3f35d867c3ece2a5n,
  0x3f0179ec9cbd821en, 0x3ecbf647612f3696n, 0x3e965e9f80f29212n, 0x3e61e54c672874dbn,
  0x3e2ca213d840baf8n, 0x3df6e80fe033c8c6n, 0x3dc2533fe68fd3d2n, 0x3d8d51ffd74c861cn,
  0x3d5774ccac3d3817n, 0x3d22c3d6f030f9acn, 0x3cee0624b3818f79n, 0x3cb804ea293472c7n,
  0x3c833721ba905bd3n, 0x3c4ebe9c5db3c61en, 0x3c18987d17c304e5n, 0x3be3ad30dfcf371dn,
  0x3baf7b816618582fn, 0x3b792f9ab81379bfn, 0x3b442615600f9499n, 0x3b101e77800c76e1n,
  0x3ad9ca58cce0be35n, 0x3aa4a1e0a3e6fe90n, 0x3a708180831f320dn, 0x3a3a68cd9e985016n,
  0x4024000000000000n, 0x4014000000000000n, 0x3fe0000000000000n, 0x3fa999999999999an,
  0x3f747ae147ae147bn, 0x3f40624dd2f1a9fcn, 0x3f0a36e2eb1c432dn, 0x3ed4f8b588e368f1n,
  0x3ea0c6f7a0b5ed8dn, 0x3e6ad7f29abcaf48n, 0x3e35798ee2308c3an, 0x3ed539223589fa95n,
  0x3ed4ff26cd5a7781n, 0x3ed4f95a762283ffn, 0x3ed4f8c60703520cn, 0x3ed4f8b72f19cd0dn,
  0x3ed4f8b5b31c0c8dn, 0x3ed4f8b58d1c461an, 0x3ed4f8b5894f7f0en, 0x3ed4f8b588ee37f3n,
  0x3ed4f8b588e47da4n, 0x3ed4f8b588e3849cn, 0x3ed4f8b588e36bb5n, 0x3ed4f8b588e36937n,
  0x3ed4f8b588e368f8n, 0x3ed4f8b588e368f1n, 0x3ff0000000000000n, 0xbff0000000000000n,
  0xbfeffffffffffffan, 0xbfeffffffffffffbn, 0x3feffffffffffffan, 0x3feffffffffffffbn,
  0x3feffffffffffffcn, 0x3feffffffffffffen, 0xbfefffffffffffffn, 0xbfefffffffffffffn,
  0x3fefffffffffffffn, 0x3fefffffffffffffn, 0x3fd3333333333332n, 0x3fd3333333333333n,
  0x3fd3333333333334n, 0x0010000000000000n, 0x000ffffffffffffdn, 0x000fffffffffffffn,
  0x7fefffffffffffffn, 0xffefffffffffffffn, 0x4340000000000000n, 0xc340000000000000n,
  0x4430000000000000n, 0x44b52d02c7e14af5n, 0x44b52d02c7e14af6n, 0x44b52d02c7e14af7n,
  0x444b1ae4d6e2ef4en, 0x444b1ae4d6e2ef4fn, 0x444b1ae4d6e2ef50n, 0x3eb0c6f7a0b5ed8cn,
  0x3eb0c6f7a0b5ed8dn, 0x41b3de4355555553n, 0x41b3de4355555554n, 0x41b3de4355555555n,
  0x41b3de4355555556n, 0x41b3de4355555557n, 0xbecbf647612f3696n, 0x43143ff3c1cb0959n,
]

/** First `count` values of the upstream sequence, paired with their raw hex. */
export function es6Sequence(count: number): readonly { readonly hex: string; readonly value: number }[] {
  const out: { hex: string; value: number }[] = []
  const push = (u: bigint): void => {
    out.push({ hex: u.toString(16), value: f64FromBits(u.toString(16).padStart(16, '0')) })
  }
  for (const u of ES6_STATIC_U64S) {
    if (out.length >= count) return out
    push(u)
  }
  for (let i = 0; out.length < count && i < 2000; i++) {
    push(0x0010000000000000n + BigInt(i))
  }
  return out
}

/**
 * Upstream `testdata/README.md` records the SHA-256 of the generated
 * `<ieee-hex>,<expected>\n` file for the first 1000 lines. Matching this proves
 * the number serializer is byte-exact against the official conformance corpus.
 */
export const ES6_EXPECTED_SHA256_1000 = 'be18b62b6f69cdab33a7e0dae0d9cfa869fda80ddc712221570f9f40a5878687'
export const ES6_LINE_COUNT_1000 = 1000
