/**
 * Validation tests.
 *
 * The handoff requires, for every built-in rule, a passing case, a failing case
 * and a missing-path case. That is the floor here, not the ceiling: a rule that
 * silently no-ops is a validation gap the buyer would never notice, so malformed
 * rule specs are tested to fail LOUDLY, and the whole surface is tested never to
 * throw (validation runs on the telemetry path, where an exception would be a
 * production incident).
 *
 * `now` is injected rather than read from the clock, so freshness tests are
 * deterministic and do not rot.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { NON_JSON_RULE, SCHEMA_RULE, unvalidatedNonJson, validate, validateRawBody } from '../src/validate.js'

/** Fixed reference time: 2026-10-13T12:00:00Z. */
const NOW = Date.parse('2026-10-13T12:00:00.000Z')

/** Build options with the fixed clock. */
const at = (rules: readonly string[]): { rules: readonly string[]; now: number } => ({ rules, now: NOW })

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

describe('non-empty', () => {
  it('passes for every non-empty JSON shape', () => {
    for (const value of [{ a: 1 }, [1], 'x', 0, false, ' ']) {
      expect(validate(value, at(['non-empty'])).passed, `value ${JSON.stringify(value)}`).toBe(true)
    }
  })

  it('fails for the four empty forms the handoff names', () => {
    for (const value of [{}, [], null, '']) {
      const result = validate(value, at(['non-empty']))
      expect(result.passed, `value ${JSON.stringify(value)}`).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('non-empty')
    }
  })

  it('fails when the body is absent entirely', () => {
    // `non-empty` is the one rule with no path argument, so the nearest analogue
    // to a "missing path" is a body that is not there at all.
    expect(validate(undefined, at(['non-empty'])).passed).toBe(false)
  })

  it('treats a whitespace-only string as non-empty, per the literal spec', () => {
    // Documented as a deliberate literal reading. Flagged in the README: a
    // whitespace-only body is arguably the silent failure this product exists to
    // catch, so this may become `value.trim() === ''`.
    expect(validate('   ', at(['non-empty'])).passed).toBe(true)
  })
})

describe('has-field', () => {
  it('passes when the field is present and non-null', () => {
    for (const value of [[1], false, 0, '', {}]) {
      expect(validate({ items: value }, at(['has-field:items'])).passed, JSON.stringify(value)).toBe(true)
    }
  })

  it('fails when the field is null', () => {
    const result = validate({ items: null }, at(['has-field:items']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toBe('items: field is null')
  })

  it('fails when the path is missing', () => {
    const result = validate({ other: 1 }, at(['has-field:items']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toBe('items: path not found')
  })

  it('resolves nested paths and array indices', () => {
    const body = { data: { items: [{ id: 7 }] } }
    expect(validate(body, at(['has-field:data.items.0.id'])).passed).toBe(true)
    expect(validate(body, at(['has-field:data.items.1.id'])).passed).toBe(false)
  })
})

describe('min-length', () => {
  it('passes at and above the minimum', () => {
    expect(validate({ items: [1, 2] }, at(['min-length:items:2'])).passed).toBe(true)
    expect(validate({ items: [1, 2, 3] }, at(['min-length:items:2'])).passed).toBe(true)
  })

  it('fails below the minimum, with the handoff\'s exact message shape', () => {
    const result = validate({ items: [] }, at(['min-length:items:1']))
    expect(result.passed).toBe(false)
    // The handoff specifies this wording: "items: expected at least 1, got 0".
    expect(result.errors[0]).toBe('items: expected at least 1, got 0')
  })

  it('passes for an empty array when the minimum is 0', () => {
    expect(validate({ items: [] }, at(['min-length:items:0'])).passed).toBe(true)
  })

  it('fails when the path is missing', () => {
    expect(validate({}, at(['min-length:items:1'])).errors[0]).toBe('items: path not found')
  })

  it('fails when the value is not an array', () => {
    const result = validate({ items: 'nope' }, at(['min-length:items:1']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toBe('items: expected an array, got string')
  })
})

describe('freshness', () => {
  it('passes for a recent timestamp', () => {
    expect(validate({ fetchedAt: '2026-10-13T11:00:00.000Z' }, at(['freshness:fetchedAt:24h'])).passed).toBe(true)
  })

  it('passes exactly at the boundary, which is not yet "older than"', () => {
    expect(validate({ fetchedAt: '2026-10-12T12:00:00.000Z' }, at(['freshness:fetchedAt:24h'])).passed).toBe(true)
  })

  it('fails for a stale timestamp', () => {
    const result = validate({ fetchedAt: '2026-10-10T12:00:00.000Z' }, at(['freshness:fetchedAt:24h']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toContain('older than 24h')
    expect(result.errors[0]).toContain('fetchedAt')
  })

  it('fails when the path is missing', () => {
    expect(validate({}, at(['freshness:fetchedAt:24h'])).errors[0]).toBe('fetchedAt: path not found')
  })

  it('fails when the value is not a parseable ISO timestamp', () => {
    for (const value of ['not-a-date', 12345, null, {}, '2026-13-45T99:99:99Z']) {
      const result = validate({ fetchedAt: value }, at(['freshness:fetchedAt:24h']))
      expect(result.passed, `value ${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('supports the documented duration units', () => {
    const body = { fetchedAt: '2026-10-13T11:59:00.000Z' } // 60s old
    expect(validate(body, at(['freshness:fetchedAt:5m'])).passed).toBe(true)
    expect(validate(body, at(['freshness:fetchedAt:30s'])).passed).toBe(false)
    expect(validate(body, at(['freshness:fetchedAt:1d'])).passed).toBe(true)
    expect(validate(body, at(['freshness:fetchedAt:2h'])).passed).toBe(true)
  })

  it('passes a future-dated timestamp, which is not older than anything', () => {
    expect(validate({ fetchedAt: '2027-01-01T00:00:00.000Z' }, at(['freshness:fetchedAt:24h'])).passed).toBe(true)
  })
})

describe('numeric-range', () => {
  it('passes inside the range, with inclusive bounds', () => {
    expect(validate({ price: 50 }, at(['numeric-range:price:10:100'])).passed).toBe(true)
    expect(validate({ price: 10 }, at(['numeric-range:price:10:100'])).passed).toBe(true)
    expect(validate({ price: 100 }, at(['numeric-range:price:10:100'])).passed).toBe(true)
  })

  it('fails below and above the range', () => {
    const low = validate({ price: 9.99 }, at(['numeric-range:price:10:100']))
    expect(low.passed).toBe(false)
    expect(low.errors[0]).toBe('price: expected within [10, 100], got 9.99')
    expect(validate({ price: 100.01 }, at(['numeric-range:price:10:100'])).passed).toBe(false)
  })

  it('fails when the path is missing', () => {
    expect(validate({}, at(['numeric-range:price:10:100'])).errors[0]).toBe('price: path not found')
  })

  it('fails when the value is not a number', () => {
    const result = validate({ price: '50' }, at(['numeric-range:price:10:100']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toBe('price: expected a number, got string')
  })

  it('handles negative bounds', () => {
    expect(validate({ temperature: -5 }, at(['numeric-range:temperature:-10:-1'])).passed).toBe(true)
    expect(validate({ temperature: 0 }, at(['numeric-range:temperature:-10:-1'])).passed).toBe(false)
  })
})

describe('no-duplicates', () => {
  it('passes for a unique array, including an empty one', () => {
    expect(validate({ tags: ['a', 'b'] }, at(['no-duplicates:tags'])).passed).toBe(true)
    expect(validate({ tags: [] }, at(['no-duplicates:tags'])).passed).toBe(true)
  })

  it('fails when values repeat', () => {
    const result = validate({ tags: ['a', 'b', 'a'] }, at(['no-duplicates:tags']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toBe('tags: expected unique values, 1 duplicate found')
  })

  it('pluralises when more than one value repeats', () => {
    const result = validate({ tags: ['a', 'a', 'b', 'b', 'b'] }, at(['no-duplicates:tags']))
    expect(result.errors[0]).toContain('3 duplicates found')
  })

  it('fails when the path is missing', () => {
    expect(validate({}, at(['no-duplicates:tags'])).errors[0]).toBe('tags: path not found')
  })

  it('fails when the value is not an array', () => {
    expect(validate({ tags: 'a' }, at(['no-duplicates:tags'])).passed).toBe(false)
  })

  it('compares objects by canonical form, so key order does not matter', () => {
    // Reuses RFC 8785 canonicalization for the identity of each element, which is
    // the same notion of equality the rest of the protocol uses.
    expect(validate({ rows: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }, at(['no-duplicates:rows'])).passed).toBe(false)
    expect(validate({ rows: [{ a: 1 }, { a: 2 }] }, at(['no-duplicates:rows'])).passed).toBe(true)
  })

  it('keeps values distinct that a loose comparison would collapse', () => {
    expect(validate({ v: [1, '1'] }, at(['no-duplicates:v'])).passed).toBe(true)
    expect(validate({ v: [null, false, 0, ''] }, at(['no-duplicates:v'])).passed).toBe(true)
    expect(validate({ v: [null, null] }, at(['no-duplicates:v'])).passed).toBe(false)
  })

  it('operates on the root when the path is empty', () => {
    expect(validate(['a', 'a'], at(['no-duplicates:'])).passed).toBe(false)
    expect(validate(['a', 'b'], at(['no-duplicates:'])).passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Malformed rule specs
// ---------------------------------------------------------------------------

describe('malformed rule specs fail loudly', () => {
  it('rejects an unknown rule name', () => {
    const result = validate({ a: 1 }, at(['no-such-rule']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toContain('no-such-rule')
    expect(result.errors[0]).toContain('unknown rule')
  })

  it('rejects a typo rather than silently skipping the check', () => {
    // A no-op rule is worse than a failing one: the buyer would believe a check
    // was applied when it was not.
    const result = validate({ items: [] }, at(['min-lenght:items:1']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toContain('unknown rule')
  })

  it('rejects a rule with its path argument missing', () => {
    expect(validate({ a: 1 }, at(['has-field'])).passed).toBe(false)
    expect(validate({ a: 1 }, at(['no-duplicates'])).errors[0]).toContain('requires a path')
  })

  it('rejects a non-integer N', () => {
    for (const spec of ['min-length:items', 'min-length:items:abc', 'min-length:items:-1', 'min-length:items:1.5']) {
      const result = validate({ items: [1, 2] }, at([spec]))
      expect(result.passed, spec).toBe(false)
    }
  })

  it('rejects an unparseable duration', () => {
    const result = validate({ fetchedAt: '2026-10-13T11:00:00.000Z' }, at(['freshness:fetchedAt:soon']))
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toContain('duration')
  })

  it('rejects non-numeric range bounds', () => {
    expect(validate({ p: 5 }, at(['numeric-range:p:low:high'])).passed).toBe(false)
    expect(validate({ p: 5 }, at(['numeric-range:p:1'])).passed).toBe(false)
  })

  it('reports the rule name in the error so the buyer can find the typo', () => {
    const result = validate({ a: 1 }, at(['min-length:items:abc']))
    expect(result.errors[0]).toContain('min-length:items:abc')
  })
})

// ---------------------------------------------------------------------------
// Zod integration
// ---------------------------------------------------------------------------

describe('zod schema integration', () => {
  const schema = z.object({ items: z.array(z.any()).min(1) })

  it('passes when the schema passes', () => {
    const result = validate({ items: [1] }, { schema })
    expect(result.passed).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.rules).toEqual([SCHEMA_RULE])
  })

  it('fails when the schema fails, surfacing the Zod issue', () => {
    const result = validate({ items: [] }, { schema })
    expect(result.passed).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('items')
  })

  it('reports multiple Zod issues', () => {
    const strict = z.object({ a: z.number(), b: z.string() })
    const result = validate({ a: 'x', b: 1 }, { schema: strict })
    expect(result.passed).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('accepts any Zod-compatible validator, not just Zod', () => {
    // Structural `SchemaLike`, so @notched/protocol needs no Zod dependency and
    // buyers can bring Valibot, ArkType or a hand-rolled validator.
    const handRolled = {
      safeParse(value: unknown) {
        const ok = typeof value === 'object' && value !== null && 'items' in value
        return ok ? { success: true as const, data: value } : { success: false as const, error: { issues: [{ message: 'items required' }] } }
      },
    }
    expect(validate({ items: [] }, { schema: handRolled }).passed).toBe(true)
    const failed = validate({}, { schema: handRolled })
    expect(failed.passed).toBe(false)
    expect(failed.errors[0]).toContain('items required')
  })
})

describe('rules and schema together', () => {
  const schema = z.object({ items: z.array(z.any()).min(1) })

  it('passes only when both pass, and lists both in `rules`', () => {
    const result = validate({ items: [1, 2] }, { schema, rules: ['non-empty', 'min-length:items:2'] })
    expect(result.passed).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.rules).toEqual(['non-empty', 'min-length:items:2', SCHEMA_RULE])
  })

  it('fails when the rules fail and the schema passes', () => {
    const result = validate({ items: [1] }, { schema, rules: ['min-length:items:2'] })
    expect(result.passed).toBe(false)
    expect(result.errors.join(' ')).toContain('expected at least 2')
  })

  it('fails when the schema fails and the rules pass', () => {
    const result = validate({ items: [] }, { schema, rules: ['has-field:items'] })
    expect(result.passed).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
  })

  it('reports errors from both when both fail', () => {
    const result = validate({ items: [] }, { schema, rules: ['min-length:items:2'] })
    expect(result.passed).toBe(false)
    expect(result.errors.some((e) => e.includes('expected at least 2'))).toBe(true)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('runs the rules even when the schema fails, so the buyer sees everything', () => {
    const result = validate({ items: [] }, { schema, rules: ['non-empty', 'min-length:items:2'] })
    expect(result.errors.filter((e) => e.includes('expected at least 2'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The null case
// ---------------------------------------------------------------------------

describe('passed: null means nothing was validated', () => {
  it('is null when neither rules nor a schema are supplied', () => {
    const result = validate({ anything: true })
    expect(result).toEqual({ passed: null, rules: [], errors: [] })
  })

  it('is null for an empty rules array with no schema', () => {
    expect(validate({ a: 1 }, { rules: [] }).passed).toBeNull()
  })

  it('is null rather than a false pass, so scorecards can exclude it', () => {
    // Reporting `true` here would be a false claim of validation. A pass rate must
    // be able to exclude "not validated" from its denominator.
    const result = validate({ a: 1 })
    expect(result.passed).not.toBe(true)
    expect(result.passed).not.toBe(false)
  })

  it('is true as soon as one check ran and passed', () => {
    expect(validate({ a: 1 }, at(['non-empty'])).passed).toBe(true)
  })
})

describe('non-JSON bodies', () => {
  it('reports unvalidated:non-json with passed null', () => {
    expect(validateRawBody('<html>not json</html>', at(['non-empty']))).toEqual({
      passed: null,
      rules: [NON_JSON_RULE],
      errors: [],
    })
  })

  it('does not run rules or a schema against a non-JSON body', () => {
    const result = validateRawBody('nope', { rules: ['non-empty'], schema: z.object({ a: z.number() }) })
    expect(result.passed).toBeNull()
    expect(result.rules).toEqual([NON_JSON_RULE])
    expect(result.errors).toEqual([])
  })

  it('validates a JSON body supplied as text', () => {
    expect(validateRawBody('{"items":[1]}', at(['min-length:items:1'])).passed).toBe(true)
    expect(validateRawBody('{"items":[]}', at(['min-length:items:1'])).passed).toBe(false)
  })

  it('distinguishes an empty body from a JSON empty string', () => {
    // `""` parses to the empty string, so `non-empty` can legitimately fail it.
    expect(validateRawBody('""', at(['non-empty'])).passed).toBe(false)
    // A zero-length body is not JSON at all, so nothing can run against it.
    expect(validateRawBody('', at(['non-empty']))).toEqual(unvalidatedNonJson())
  })

  it('exposes the helper the SDK uses to mark a body unvalidated', () => {
    expect(unvalidatedNonJson()).toEqual({ passed: null, rules: [NON_JSON_RULE], errors: [] })
  })

  it('reports a rule id the handoff names exactly', () => {
    expect(NON_JSON_RULE).toBe('unvalidated:non-json')
  })
})

// ---------------------------------------------------------------------------
// Path resolution and robustness
// ---------------------------------------------------------------------------

describe('path resolution', () => {
  const body = { data: { rows: [{ id: 1 }, { id: 2 }] } }

  it('supports nested objects and array indices', () => {
    expect(validate(body, at(['has-field:data.rows.1.id'])).passed).toBe(true)
    expect(validate(body, at(['numeric-range:data.rows.1.id:1:5'])).passed).toBe(true)
    expect(validate(body, at(['min-length:data.rows:2'])).passed).toBe(true)
  })

  it('fails rather than throwing when traversal lands on a non-object', () => {
    expect(validate({ a: 'string' }, at(['has-field:a.b'])).passed).toBe(false)
    expect(validate({ a: 1 }, at(['has-field:a.b.c'])).passed).toBe(false)
  })

  it('treats an out-of-range index as missing', () => {
    expect(validate({ a: [1] }, at(['has-field:a.5'])).errors[0]).toBe('a.5: path not found')
  })

  it('treats a non-numeric segment on an array as missing', () => {
    expect(validate({ a: [1] }, at(['has-field:a.first'])).passed).toBe(false)
  })

  it('distinguishes null from missing', () => {
    expect(validate({ a: null }, at(['has-field:a'])).errors[0]).toBe('a: field is null')
    expect(validate({}, at(['has-field:a'])).errors[0]).toBe('a: path not found')
  })

  it('treats an explicitly undefined leaf as missing, since JSON has no undefined', () => {
    expect(validate({ a: undefined }, at(['has-field:a'])).errors[0]).toBe('a: path not found')
  })
})

describe('fail-open robustness', () => {
  it('never throws, even when property access itself throws', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('boom')
        },
      },
    )
    expect(() => validate(hostile, at(['has-field:a']))).not.toThrow()
    expect(validate(hostile, at(['has-field:a'])).passed).toBe(false)
  })

  it('never throws when duplicate detection meets an uncanonicalisable value', () => {
    // `undefined` is not I-JSON, so canonicalization rejects it; duplicate
    // detection must fall back rather than propagate.
    expect(() => validate([undefined, undefined], at(['no-duplicates:']))).not.toThrow()
    expect(validate([undefined, undefined], at(['no-duplicates:'])).passed).toBe(false)
  })

  it('completes every rule for a deeply nested payload', () => {
    const deep = { a: { b: { c: { d: [{ e: 1 }] } } } }
    const result = validate(deep, at(['non-empty', 'has-field:a.b.c.d.0.e', 'min-length:a.b.c.d:1']))
    expect(result.passed).toBe(true)
  })
})
