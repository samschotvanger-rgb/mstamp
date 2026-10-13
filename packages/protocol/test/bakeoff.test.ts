/**
 * Canonicalizer bake-off.
 *
 * Decides - on measured behaviour, not on a README claim - which RFC 8785
 * implementation `src/canonical.ts` delegates to.
 *
 * Two things are scored separately:
 *
 *   1. CONFORMANCE on valid I-JSON input. This is asserted, and the selected
 *      candidate must be perfect. A single wrong byte here invalidates every
 *      receipt the notary ever signs.
 *
 *   2. ERROR SEMANTICS on invalid input. This is only *reported*, not asserted,
 *      because no mainstream JS canonicalizer enforces all of RFC 8785's
 *      rejection rules. Recording the gaps is what justifies the explicit
 *      I-JSON guard in `src/canonical.ts`.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { loadCandidates, probe, mustRejectInputs, type CanonicalizerCandidate } from './lib/canonicalizer-candidates.js'
import {
  APPENDIX_B_NON_JSON_BITS,
  APPENDIX_B_NUMBERS,
  ES6_EXPECTED_SHA256_1000,
  ES6_LINE_COUNT_1000,
  ES6_STATIC_U64S,
  OFFICIAL_VECTORS,
  es6Sequence,
  f64FromBits,
  normalizeHex,
} from './vectors/rfc8785.js'

/**
 * The implementation `src/canonical.ts` delegates to.
 *
 * Changing this constant is a protocol-level decision: it changes the bytes
 * every receipt is signed over. Update `docs/canonicalization-decision.md` in
 * the same commit.
 */
const SELECTED_CANONICALIZER = 'canonicalize'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Regenerate the upstream ES6 number test file format: `<ieee-hex>,<expected>\n`. */
function es6TestFile(candidate: CanonicalizerCandidate, count: number): string {
  return es6Sequence(count)
    .map(({ hex, value }) => `${hex},${candidate.canonicalize(value)}\n`)
    .join('')
}

const candidates = await loadCandidates()

describe('canonicalizer bake-off - RFC 8785 conformance', () => {
  it('has all candidates installed', () => {
    for (const c of candidates) {
      console.log(`  ${c.id.padEnd(18)} v${c.version.padEnd(10)} ${c.note}`)
    }
    expect(candidates.map((c) => c.id)).toEqual(['canonicalize', 'json-canonicalize', 'json-freeze'])
  })

  it('passes all six official RFC 8785 vectors', () => {
    const failures: string[] = []

    for (const c of candidates) {
      for (const vector of OFFICIAL_VECTORS) {
        const input: unknown = JSON.parse(vector.inputJson)
        const expected = normalizeHex(vector.expectedHex)
        const outcome = probe(c.canonicalize, input)
        const actual =
          outcome.kind === 'returned' ? Buffer.from(outcome.output, 'utf8').toString('hex') : `<threw: ${outcome.message}>`

        const ok = actual === expected
        if (!ok) failures.push(`${c.id} / ${vector.name}`)
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${vector.name}`)
        if (!ok) {
          console.log(`        expected ${expected}`)
          console.log(`        actual   ${actual}`)
        }
      }
    }

    const selectedFailures = failures.filter((f) => f.startsWith(`${SELECTED_CANONICALIZER} /`))
    expect(selectedFailures, `selected canonicalizer failed official vectors`).toEqual([])
  })

  it('passes all RFC 8785 Appendix B number vectors', () => {
    for (const c of candidates) {
      const wrong: string[] = []
      for (const row of APPENDIX_B_NUMBERS) {
        const value = f64FromBits(row.bits)
        const outcome = probe(c.canonicalize, value)
        const actual = outcome.kind === 'returned' ? outcome.output : `<threw: ${outcome.message}>`
        if (actual !== row.expected) wrong.push(`${row.bits}: expected ${row.expected}, got ${actual}`)
      }
      console.log(`  ${wrong.length === 0 ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${APPENDIX_B_NUMBERS.length - wrong.length}/${APPENDIX_B_NUMBERS.length} number vectors`)
      for (const w of wrong.slice(0, 8)) console.log(`        ${w}`)
      if (wrong.length > 8) console.log(`        ...and ${wrong.length - 8} more`)
    }

    const selected = candidates.find((c) => c.id === SELECTED_CANONICALIZER)!
    for (const row of APPENDIX_B_NUMBERS) {
      expect(probe(selected.canonicalize, f64FromBits(row.bits)), `bits ${row.bits} (${row.comment})`).toEqual({
        kind: 'returned',
        output: row.expected,
      })
    }
  })

  it('reproduces the official ES6 number conformance hash over 1000 lines', () => {
    // Sanity check on the vendored constant list: 42 rows of 4.
    expect(ES6_STATIC_U64S.length, 'transcribed ES6 static value count').toBe(168)

    for (const c of candidates) {
      const hash = sha256Hex(es6TestFile(c, ES6_LINE_COUNT_1000))
      const ok = hash === ES6_EXPECTED_SHA256_1000
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${hash}`)
    }

    const selected = candidates.find((c) => c.id === SELECTED_CANONICALIZER)!
    expect(sha256Hex(es6TestFile(selected, ES6_LINE_COUNT_1000))).toBe(ES6_EXPECTED_SHA256_1000)
  })

  it('records error semantics on non-I-JSON input (report only)', () => {
    const inputs = mustRejectInputs()

    console.log('  RFC 8785 requires these to be REJECTED. "-" means the value was silently serialised instead:')
    const header = ['input'.padEnd(28), ...candidates.map((c) => c.id.padEnd(18))].join(' ')
    console.log(`  ${header}`)

    for (const input of inputs) {
      const cells = candidates.map((c) => {
        const outcome = probe(c.canonicalize, input.value)
        return (outcome.kind === 'threw' ? 'rejected' : `returned ${JSON.stringify(outcome.output)}`).slice(0, 17).padEnd(18)
      })
      console.log(`  ${input.label.padEnd(28)} ${cells.join(' ')}`)
    }

    for (const row of APPENDIX_B_NON_JSON_BITS) {
      const cells = candidates.map((c) => {
        const outcome = probe(c.canonicalize, f64FromBits(row.bits))
        return (outcome.kind === 'threw' ? 'rejected' : `returned ${JSON.stringify(outcome.output)}`).slice(0, 17).padEnd(18)
      })
      console.log(`  ${row.comment.padEnd(28)} ${cells.join(' ')}`)
    }

    // Intentionally no assertion - see the file header. The guard that closes
    // these gaps is tested in canonical.test.ts.
  })
})
