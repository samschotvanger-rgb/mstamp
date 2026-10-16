/**
 * Canonicalization conformance and guard tests.
 *
 * Two responsibilities, deliberately separated:
 *
 *   A. CONFORMANCE - our wrapper must be byte-identical to RFC 8785. Verified
 *      against the official IETF vector corpus, the Appendix B number table,
 *      and the official 1000-line ES6 number conformance hash.
 *
 *   B. GUARD - our wrapper must be STRICTER than every candidate library, which
 *      the bake-off showed all silently drop `undefined`/function/symbol values.
 *      A notary that hashes a payload it silently rewrote is attesting to
 *      something the caller never sent.
 */

import { createHash } from 'node:crypto'
import canonicalizeImpl from 'canonicalize'
import { describe, expect, it } from 'vitest'

import { CanonicalizationError, canonicalizeJson, canonicalizeToBytes } from '../src/canonical.js'
import {
  APPENDIX_B_NON_JSON_BITS,
  APPENDIX_B_NUMBERS,
  ES6_EXPECTED_SHA256_1000,
  ES6_LINE_COUNT_1000,
  OFFICIAL_VECTORS,
  es6Sequence,
  f64FromBits,
  normalizeHex,
} from './vectors/rfc8785.js'

const utf8Hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex')

// ---------------------------------------------------------------------------
// A. Conformance
// ---------------------------------------------------------------------------

describe('canonicalizeJson - RFC 8785 conformance', () => {
  it.each(OFFICIAL_VECTORS.map((v) => [v.name, v] as const))('matches official vector %s', (_name, vector) => {
    const parsed: unknown = JSON.parse(vector.inputJson)
    expect(utf8Hex(canonicalizeJson(parsed))).toBe(normalizeHex(vector.expectedHex))
  })

  it.each(APPENDIX_B_NUMBERS.map((r) => [r.bits, r.comment, r] as const))(
    'serialises IEEE-754 bits %s (%s) as RFC 8785 requires',
    (_bits, _comment, row) => {
      expect(canonicalizeJson(f64FromBits(row.bits))).toBe(row.expected)
    },
  )

  it('reproduces the official ES6 number conformance hash over 1000 lines', () => {
    const file = es6Sequence(ES6_LINE_COUNT_1000)
      .map(({ hex, value }) => `${hex},${canonicalizeJson(value)}\n`)
      .join('')
    expect(createHash('sha256').update(file, 'utf8').digest('hex')).toBe(ES6_EXPECTED_SHA256_1000)
  })

  it('is byte-neutral: the guard never changes output for valid input', () => {
    // The guard exists to reject bad input, not to transform good input. If it
    // ever altered a byte it would silently change every receipt hash, so this
    // compares our output against the raw library for every official vector.
    const validInputs: unknown[] = [
      ...OFFICIAL_VECTORS.map((v) => JSON.parse(v.inputJson) as unknown),
      ...APPENDIX_B_NUMBERS.map((r) => f64FromBits(r.bits)),
      null,
      true,
      false,
      0,
      -0,
      '',
      'plain',
      [1, 'two', null, false],
      { z: 1, a: { c: 3, b: 2 } },
    ]
    for (const input of validInputs) {
      expect(canonicalizeJson(input)).toBe(canonicalizeImpl(input))
    }
  })
})

// ---------------------------------------------------------------------------
// B. Guard
// ---------------------------------------------------------------------------

const expectRejection = (value: unknown, code: CanonicalizationError['code']): void => {
  try {
    canonicalizeJson(value)
    throw new Error('expected canonicalizeJson to reject, but it returned a value')
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalizationError)
    expect((error as CanonicalizationError).code).toBe(code)
  }
}

describe('canonicalizeJson - I-JSON guard', () => {
  it('rejects NaN and non-finite numbers', () => {
    expectRejection(Number.NaN, 'NON_FINITE_NUMBER')
    expectRejection({ a: [1, Number.POSITIVE_INFINITY] }, 'NON_FINITE_NUMBER')
    expectRejection(Number.NEGATIVE_INFINITY, 'NON_FINITE_NUMBER')
  })

  it('rejects the non-JSON IEEE-754 bit patterns called out by RFC 8785', () => {
    for (const row of APPENDIX_B_NON_JSON_BITS) {
      expect(() => canonicalizeJson(f64FromBits(row.bits)), row.comment).toThrow(CanonicalizationError)
    }
  })

  it('rejects values JSON cannot represent', () => {
    expectRejection(1n, 'UNSUPPORTED_TYPE')
    expectRejection({ a: undefined }, 'UNSUPPORTED_TYPE')
    expectRejection([undefined], 'UNSUPPORTED_TYPE')
    expectRejection({ a: () => 1 }, 'UNSUPPORTED_TYPE')
    expectRejection({ a: Symbol('s') }, 'UNSUPPORTED_TYPE')
  })

  it('rejects undefined at the root rather than returning undefined', () => {
    expectRejection(undefined, 'UNSUPPORTED_TYPE')
  })

  it('rejects non-plain objects whose JSON form would be lossy or surprising', () => {
    // `JSON.stringify(new Map([[1,2]]))` is `{}`, and a Date would silently
    // become a string via toJSON. Both would produce a receipt for a payload
    // that never existed, so they are rejected instead.
    expectRejection(new Date(0), 'UNSUPPORTED_TYPE')
    expectRejection(new Map([['a', 1]]), 'UNSUPPORTED_TYPE')
    expectRejection(new Set([1]), 'UNSUPPORTED_TYPE')
    class Widget {
      readonly a = 1
    }
    expectRejection(new Widget(), 'UNSUPPORTED_TYPE')
  })

  it('accepts null-prototype objects', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare['a'] = 1
    expect(canonicalizeJson(bare)).toBe('{"a":1}')
  })

  it('rejects lone surrogates, which RFC 8785 requires to be fatal', () => {
    // This is the MUST that json-freeze violated in the bake-off.
    expectRejection('\ud800', 'LONE_SURROGATE')
    expectRejection({ key: 'ok\udfff' }, 'LONE_SURROGATE')
    expectRejection({ '\ud800': 1 }, 'LONE_SURROGATE')
  })

  it('accepts a well-formed surrogate pair', () => {
    expect(canonicalizeJson({ emoji: '\ud83d\ude02' })).toBe('{"emoji":"\u{1F602}"}')
  })

  it('rejects circular references but allows shared (acyclic) references', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expectRejection(circular, 'CIRCULAR_REFERENCE')

    const shared = { n: 1 }
    // A diamond is not a cycle. Treating repeated references as circular would
    // reject perfectly ordinary payloads, so the check tracks the current path,
    // not every object ever seen.
    expect(canonicalizeJson({ a: shared, b: shared })).toBe('{"a":{"n":1},"b":{"n":1}}')
  })

  it('reports the path to the offending value', () => {
    try {
      canonicalizeJson({ outer: { list: [1, { bad: Number.NaN }] } })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError)
      expect((error as CanonicalizationError).path).toEqual(['outer', 'list', '1', 'bad'])
      expect((error as CanonicalizationError).message).toContain('outer.list.1.bad')
    }
  })
})

// ---------------------------------------------------------------------------
// C. The individual rules the original spec enumerates
// ---------------------------------------------------------------------------

describe('canonicalizeJson - rule coverage', () => {
  it('sorts object keys lexicographically by UTF-16 code unit', () => {
    expect(canonicalizeJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
    // RFC 8785 3.2.3: "" < "a" < "aa" < "ab"
    expect(canonicalizeJson({ ab: 1, a: 2, aa: 3, '': 4 })).toBe('{"":4,"a":2,"aa":3,"ab":1}')
    // Digits sort before uppercase before lowercase in UTF-16 order.
    expect(canonicalizeJson({ a: 1, A: 2, '1': 3 })).toBe('{"1":3,"A":2,"a":1}')
  })

  it('produces identical bytes regardless of property insertion order', () => {
    const one = { provider: 'scraper-x', statusCode: 200, nested: { z: 1, a: 2 } }
    const two = { nested: { a: 2, z: 1 }, statusCode: 200, provider: 'scraper-x' }
    expect(canonicalizeJson(one)).toBe(canonicalizeJson(two))
  })

  it('sorts keys recursively, including objects nested inside arrays', () => {
    const input = { list: [{ b: 1, a: 2 }, { d: 4, c: 3 }], top: { y: 1, x: 2 } }
    expect(canonicalizeJson(input)).toBe('{"list":[{"a":2,"b":1},{"c":3,"d":4}],"top":{"x":2,"y":1}}')
  })

  it('sorts with the RFC 8785 3.2.3 worked example', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }
    const order = [
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]

    const output = canonicalizeJson(input)

    // Every value survives...
    for (const value of order) expect(output).toContain(value)

    // ...and they appear in exactly the sequence RFC 8785 documents. Note this
    // is case-insensitive French-hostile order ("Control" before "Euro Sign"),
    // which is the point of the vector: sorting ignores locale.
    const positions = order.map((v) => output.indexOf(v))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('sorts an astral character before a higher BMP character, per UTF-16 order', () => {
    // U+1F602 encodes as the surrogate pair D83D DE02, so its first code unit is
    // 0xD83D. U+FB33 is a single unit 0xFB33. UTF-16 order therefore puts the
    // emoji FIRST, even though its code point is larger. Sorting by code point
    // produces the wrong bytes here - this was the trap in the official
    // `weird.json` vector.
    const output = canonicalizeJson({ '\ud83d\ude02': 1, '\ufb33': 2 })
    expect(output.indexOf('\ud83d\ude02')).toBeLessThan(output.indexOf('\ufb33'))
    expect(output).toBe('{"\u{1F602}":1,"\ufb33":2}')
  })

  it('emits no whitespace outside strings', () => {
    const output = canonicalizeJson({ b: [1, 2, { c: null }], a: true })
    expect(output).toBe('{"a":true,"b":[1,2,{"c":null}]}')
    expect(output).not.toMatch(/[\s]/)
  })

  it('emits a pretty-printed input identically to its compact form', () => {
    const pretty = '{\n  "b": 1,\n  "a": [ 1, 2 ]\n}'
    const compact = '{"b":1,"a":[1,2]}'
    expect(canonicalizeJson(JSON.parse(pretty) as unknown)).toBe(canonicalizeJson(JSON.parse(compact) as unknown))
  })

  it('preserves array element order', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalizeJson(['b', 'a'])).toBe('["b","a"]')
  })

  it('serialises literals as bare keywords', () => {
    expect(canonicalizeJson([null, true, false])).toBe('[null,true,false]')
    expect(canonicalizeJson({ n: null, t: true, f: false })).toBe('{"f":false,"n":null,"t":true}')
  })

  it('escapes only what RFC 8785 requires, and non-ASCII not at all', () => {
    // Control characters use the short forms where they exist, lowercase \u
    // otherwise; everything outside the C0 range is emitted literally.
    expect(canonicalizeJson({ s: '\b\t\n\f\r' })).toBe('{"s":"\\b\\t\\n\\f\\r"}')
    expect(canonicalizeJson({ s: '\u0000\u001f' })).toBe('{"s":"\\u0000\\u001f"}')
    expect(canonicalizeJson({ s: '"\\' })).toBe('{"s":"\\"\\\\"}')
    // U+2028/U+2029 are NOT escaped by JCS, unlike some JSON serialisers.
    expect(canonicalizeJson({ s: '\u2028\u2029' })).toBe('{"s":"\u2028\u2029"}')
    expect(canonicalizeJson({ s: '€ünïcødé' })).toBe('{"s":"€ünïcødé"}')
  })

  it('does NOT apply Unicode NFC normalisation - it preserves input as-is', () => {
    // The original spec listed "Normalize unicode to NFC" as an RFC 8785 rule.
    // It is not one: RFC 8785 3.1 states JCS does not consider Unicode
    // Normalization and that all components MUST preserve string data "as is".
    // The official `unicode.json` vector proves it - expected output is
    // `41 cc 8a` (A + U+030A), not `c3 85` (U+00C5).
    const decomposed = 'A\u030a' // A + COMBINING RING ABOVE (NFD)
    const precomposed = '\u00c5' // LATIN CAPITAL LETTER A WITH RING ABOVE (NFC)

    expect(utf8Hex(canonicalizeJson({ k: decomposed }))).toBe('7b226b223a2241cc8a227d')
    expect(utf8Hex(canonicalizeJson({ k: precomposed }))).toBe('7b226b223a22c385227d')

    // They are distinct inputs and must therefore produce distinct bytes.
    expect(decomposed.normalize('NFC')).toBe(precomposed)
    expect(canonicalizeJson({ k: decomposed })).not.toBe(canonicalizeJson({ k: precomposed }))
  })

  it('is idempotent when re-canonicalised', () => {
    const input = { b: 1, a: { s: 'x', n: [1.5, -0, 1e21] } }
    const once = canonicalizeJson(input)
    expect(canonicalizeJson(JSON.parse(once) as unknown)).toBe(once)
  })

  it('exposes UTF-8 bytes that match the canonical string', () => {
    const input = { s: '€', n: 1e21 }
    const bytes = canonicalizeToBytes(input)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes).toString('utf8')).toBe(canonicalizeJson(input))
    // No BOM, no trailing newline.
    expect(bytes[0]).toBe(0x7b)
    expect(bytes[bytes.length - 1]).toBe(0x7d)
  })
})
