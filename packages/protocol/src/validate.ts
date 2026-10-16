/**
 * Response validation: buyer-declared rules, plus an optional schema.
 *
 * Validation runs in the SDK, never on the server. The backend stores the verdict;
 * it does not compute one. That keeps the buyer's schema private and means a
 * validation change never requires a deploy.
 *
 * Three design commitments:
 *
 *   1. **Never throws.** This runs on the telemetry path, in-process with a live
 *      application. An exception here would be a production incident caused by an
 *      observability feature, so every rule is individually guarded and a failure
 *      becomes an error string instead.
 *
 *   2. **Never silently no-ops.** A malformed or misspelled rule fails loudly. A
 *      rule that quietly did nothing would leave the buyer believing a check was
 *      applied when it was not - a validation gap that looks like a clean bill of
 *      health.
 *
 *   3. **`passed: null` means "not validated", not "passed".** With no rules and
 *      no schema nothing has been checked, so claiming `true` would be a false
 *      assertion of quality. Scorecards can then exclude nulls from a pass rate
 *      rather than having unvalidated calls inflate it.
 *
 * Zod is supported but NOT required: `SchemaLike` is structural, so Zod, Valibot,
 * ArkType or a hand-rolled validator all work, and `@mstamp/protocol` carries no
 * runtime dependency on any of them.
 */

import { canonicalizeJson } from './canonical.js'
import type { ValidationResult } from './types.js'

/** Rule id recorded when the body was not JSON and therefore could not be validated. */
export const NON_JSON_RULE = 'unvalidated:non-json'

/** Rule id recorded when a schema was supplied. Deliberately schema-library-neutral. */
export const SCHEMA_RULE = 'schema'

/** The six built-in rules from the original spec. */
export const BUILT_IN_RULES = [
  'non-empty',
  'has-field',
  'min-length',
  'freshness',
  'numeric-range',
  'no-duplicates',
] as const

export type BuiltInRule = (typeof BUILT_IN_RULES)[number]

/**
 * Anything with a Zod-style `safeParse`.
 *
 * Typed loosely on purpose: the return value is narrowed at runtime, so this
 * accepts Zod v3, Zod v4 and non-Zod validators alike without pinning a version.
 */
export type SchemaLike = {
  safeParse(value: unknown): unknown
}

export type ValidationOptions = {
  /** Rule specs, e.g. `['non-empty', 'min-length:items:1']`. */
  rules?: readonly string[]
  /** Optional schema. Both the rules and the schema must pass for `passed: true`. */
  schema?: SchemaLike
  /**
   * Reference time in ms for `freshness`, defaulting to `Date.now()`.
   *
   * Injectable so freshness is testable and deterministic; tests would otherwise
   * rot as the wall clock moved.
   */
  now?: number
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

type PathResolution = { readonly found: true; readonly value: unknown } | { readonly found: false }

const NOT_FOUND: PathResolution = { found: false }

/**
 * Resolve a dot-separated path, supporting array indices: `data.rows.0.id`.
 *
 * Paths cannot contain `:` because `:` separates a rule's arguments.
 *
 * An empty path means the root value, which lets path-taking rules operate on a
 * whole body that is itself an array.
 */
function resolvePath(root: unknown, path: string): PathResolution {
  if (path === '') return { found: true, value: root }

  let current: unknown = root

  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return NOT_FOUND
      const index = Number(segment)
      if (index >= current.length) return NOT_FOUND
      current = current[index]
      continue
    }

    if (current === null || typeof current !== 'object') return NOT_FOUND

    const record = current as Record<string, unknown>
    // hasOwnProperty, not `in`: an inherited property is not part of the payload.
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return NOT_FOUND

    const next = record[segment]
    // JSON has no `undefined`, so an undefined leaf is an absent field.
    if (next === undefined) return NOT_FOUND

    current = next
  }

  return { found: true, value: current }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Short type description for error messages. Never dumps the payload. */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Short value description for error messages. */
function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** `body` reads better than an empty string when a rule targets the root. */
function pathLabel(path: string): string {
  return path === '' ? 'body' : path
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

function parseDuration(text: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (match === null) return null

  const amountText = match[1]
  const unit = match[2]
  if (amountText === undefined || unit === undefined) return null

  const multiplier = DURATION_UNITS[unit]
  if (multiplier === undefined) return null

  return Number(amountText) * multiplier
}

// ---------------------------------------------------------------------------
// Element identity, for no-duplicates
// ---------------------------------------------------------------------------

/**
 * Canonical form of an array element, reused as its identity.
 *
 * Using RFC 8785 means `{a:1,b:2}` and `{b:2,a:1}` are the same value - the same
 * notion of equality the rest of the protocol uses - while `1` and `'1'` stay
 * distinct, which a loose comparison would collapse.
 */
function dedupeKey(value: unknown): string {
  try {
    return canonicalizeJson(value)
  } catch {
    // Not I-JSON (e.g. `undefined`), which RFC 8785 refuses to serialise. Fall back
    // to a type-tagged rendering so this rule degrades instead of throwing.
    let rendered: string
    try {
      rendered = JSON.stringify(value) ?? String(value)
    } catch {
      rendered = String(value)
    }
    return `${typeof value}:${rendered}`
  }
}

// ---------------------------------------------------------------------------
// The six built-in rules
// ---------------------------------------------------------------------------

function describeEmptiness(value: unknown): string {
  if (value === undefined) return 'a missing body'
  if (value === null) return 'null'
  if (typeof value === 'string') return value === '' ? 'an empty string' : 'a whitespace-only string'
  if (Array.isArray(value)) return 'an empty array'
  return 'an empty object'
}

function ruleNonEmpty(body: unknown): string[] {
  const empty =
    body === null ||
    body === undefined ||
    // Trimmed, so a body of only whitespace counts as empty. Ruled 2026-10-13: a
    // whitespace-only response is exactly the silent failure this rule exists to
    // catch. Surrounding whitespace around real content is not emptiness.
    (typeof body === 'string' && body.trim() === '') ||
    (Array.isArray(body) && body.length === 0) ||
    (isRecord(body) && !Array.isArray(body) && Object.keys(body).length === 0)

  return empty ? [`body: expected non-empty, got ${describeEmptiness(body)}`] : []
}

function ruleHasField(body: unknown, spec: string, parts: readonly string[]): string[] {
  const path = parts[1]
  if (path === undefined) return [`${spec}: requires a path`]

  const resolved = resolvePath(body, path)
  if (!resolved.found) return [`${pathLabel(path)}: path not found`]
  if (resolved.value === null) return [`${pathLabel(path)}: field is null`]

  return []
}

function ruleMinLength(body: unknown, spec: string, parts: readonly string[]): string[] {
  const path = parts[1]
  const rawMinimum = parts[2]
  if (path === undefined || rawMinimum === undefined) {
    return [`${spec}: requires a path and a length, e.g. min-length:items:1`]
  }
  if (!/^\d+$/.test(rawMinimum)) {
    return [`${spec}: N must be a non-negative integer`]
  }

  const resolved = resolvePath(body, path)
  if (!resolved.found) return [`${pathLabel(path)}: path not found`]

  const value = resolved.value
  if (!Array.isArray(value)) {
    return [`${pathLabel(path)}: expected an array, got ${describeType(value)}`]
  }

  const minimum = Number(rawMinimum)
  if (value.length < minimum) {
    return [`${pathLabel(path)}: expected at least ${minimum}, got ${value.length}`]
  }

  return []
}

function ruleFreshness(body: unknown, spec: string, parts: readonly string[], now: number): string[] {
  const path = parts[1]
  const rawDuration = parts[2]
  if (path === undefined || rawDuration === undefined) {
    return [`${spec}: requires a path and a duration, e.g. freshness:createdAt:24h`]
  }

  const durationMs = parseDuration(rawDuration)
  if (durationMs === null) {
    return [`${spec}: duration must look like 30s, 15m, 24h or 7d`]
  }

  const resolved = resolvePath(body, path)
  if (!resolved.found) return [`${pathLabel(path)}: path not found`]

  const value = resolved.value
  if (typeof value !== 'string') {
    return [`${pathLabel(path)}: expected an ISO 8601 timestamp string, got ${describeType(value)}`]
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return [`${pathLabel(path)}: could not parse ${describeValue(value)} as an ISO 8601 timestamp`]
  }

  const ageMs = now - parsed
  if (ageMs > durationMs) {
    const hours = Math.round((ageMs / 3_600_000) * 10) / 10
    return [`${pathLabel(path)}: older than ${rawDuration} (${hours}h old)`]
  }

  return []
}

function ruleNumericRange(body: unknown, spec: string, parts: readonly string[]): string[] {
  const path = parts[1]
  const rawMin = parts[2]
  const rawMax = parts[3]
  if (path === undefined || rawMin === undefined || rawMax === undefined) {
    return [`${spec}: requires a path, a minimum and a maximum, e.g. numeric-range:price:0:100`]
  }

  const minimum = Number(rawMin)
  const maximum = Number(rawMax)
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    return [`${spec}: bounds must be finite numbers`]
  }
  if (minimum > maximum) {
    return [`${spec}: minimum is greater than maximum`]
  }

  const resolved = resolvePath(body, path)
  if (!resolved.found) return [`${pathLabel(path)}: path not found`]

  const value = resolved.value
  if (typeof value !== 'number') {
    return [`${pathLabel(path)}: expected a number, got ${describeType(value)}`]
  }
  // NaN passes both `<` and `>` comparisons, so it must be rejected explicitly.
  if (!Number.isFinite(value)) {
    return [`${pathLabel(path)}: expected a finite number, got ${describeValue(value)}`]
  }

  if (value < minimum || value > maximum) {
    return [`${pathLabel(path)}: expected within [${minimum}, ${maximum}], got ${describeValue(value)}`]
  }

  return []
}

function ruleNoDuplicates(body: unknown, spec: string, parts: readonly string[]): string[] {
  const path = parts[1]
  if (path === undefined) return [`${spec}: requires a path`]

  const resolved = resolvePath(body, path)
  if (!resolved.found) return [`${pathLabel(path)}: path not found`]

  const value = resolved.value
  if (!Array.isArray(value)) {
    return [`${pathLabel(path)}: expected an array, got ${describeType(value)}`]
  }

  const seen = new Set<string>()
  let duplicates = 0
  for (const item of value) {
    const key = dedupeKey(item)
    if (seen.has(key)) duplicates++
    else seen.add(key)
  }

  return duplicates === 0
    ? []
    : [`${pathLabel(path)}: expected unique values, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} found`]
}

function applyRule(body: unknown, spec: string, now: number): string[] {
  const parts = spec.split(':')
  const name = parts[0] ?? ''

  switch (name) {
    case 'non-empty':
      return ruleNonEmpty(body)
    case 'has-field':
      return ruleHasField(body, spec, parts)
    case 'min-length':
      return ruleMinLength(body, spec, parts)
    case 'freshness':
      return ruleFreshness(body, spec, parts, now)
    case 'numeric-range':
      return ruleNumericRange(body, spec, parts)
    case 'no-duplicates':
      return ruleNoDuplicates(body, spec, parts)
    default:
      return [`${spec}: unknown rule (expected one of ${BUILT_IN_RULES.join(', ')})`]
  }
}

/** Run a rule, converting any throw into an error string. Fail-open by design. */
function applyRuleSafely(body: unknown, spec: string, now: number): string[] {
  try {
    return applyRule(body, spec, now)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [`${spec}: rule raised an error (${detail})`]
  }
}

// ---------------------------------------------------------------------------
// Schema integration
// ---------------------------------------------------------------------------

/** Turn a Zod-style issue into `"path: message"`, or null when unusable. */
function renderIssue(issue: unknown): string | null {
  if (!isRecord(issue)) return null

  const message = typeof issue['message'] === 'string' ? issue['message'] : null
  if (message === null) return null

  const path = issue['path']
  if (Array.isArray(path) && path.length > 0) {
    return `${path.join('.')}: ${message}`
  }
  return message
}

function extractIssues(error: unknown): string[] {
  if (isRecord(error)) {
    const issues = error['issues']
    if (Array.isArray(issues)) {
      const rendered = issues.map(renderIssue).filter((entry): entry is string => entry !== null)
      if (rendered.length > 0) return rendered
    }

    const message = error['message']
    if (typeof message === 'string' && message !== '') return [message]
  }

  if (error instanceof Error) return [error.message]
  return [String(error)]
}

function applySchema(schema: SchemaLike, value: unknown): string[] {
  let result: unknown
  try {
    result = schema.safeParse(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [`schema: validator raised an error (${detail})`]
  }

  if (isRecord(result) && result['success'] === true) return []

  const error = isRecord(result) ? result['error'] : result
  return extractIssues(error === undefined ? 'schema validation failed' : error)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an already-parsed JSON value.
 *
 * Rules and schema both run when both are supplied; both must pass for
 * `passed: true`. With neither, `passed` is `null` because nothing was checked.
 */
export function validate(value: unknown, options: ValidationOptions = {}): ValidationResult {
  const ruleSpecs = options.rules ?? []
  const schema = options.schema
  const now = options.now ?? Date.now()

  const errors: string[] = []
  const appliedRules: string[] = []

  for (const spec of ruleSpecs) {
    appliedRules.push(spec)
    errors.push(...applyRuleSafely(value, spec, now))
  }

  if (schema !== undefined) {
    appliedRules.push(SCHEMA_RULE)
    errors.push(...applySchema(schema, value))
  }

  // Nothing ran: not validated, which is not the same as passed.
  const ranACheck = appliedRules.length > 0

  return {
    passed: ranACheck ? errors.length === 0 : null,
    rules: appliedRules,
    errors,
  }
}

/** The verdict for a body that is not JSON: hashed, but not validated. */
export function unvalidatedNonJson(): ValidationResult {
  return { passed: null, rules: [NON_JSON_RULE], errors: [] }
}

/**
 * Validate a raw response body as text.
 *
 * Per the V1 spec, a non-JSON body is hashed and marked `unvalidated:non-json`
 * with `passed: null` rather than treated as a failure - the notary records what
 * happened, it does not judge it.
 *
 * Note the distinction the two inputs carry: `''` is not JSON at all, so nothing
 * can run; `'""'` parses to the empty string, so `non-empty` can legitimately fail
 * it. Both are covered in the tests.
 */
export function validateRawBody(text: string, options: ValidationOptions = {}): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return unvalidatedNonJson()
  }

  return validate(parsed, options)
}
