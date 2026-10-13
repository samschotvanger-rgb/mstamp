/**
 * Candidate RFC 8785 canonicalizers, behind one interface.
 *
 * This exists for one reason: the V1 handoff names `json-freeze`, but a
 * canonicalization bug invalidates every receipt ever issued, so the choice has
 * to be made on measured behaviour rather than on a README claim. Every
 * candidate runs against the identical official vector corpus and is scored on
 * correctness *and* on error semantics.
 *
 * The chosen implementation is used by `src/canonical.ts`. The two runners-up
 * stay in devDependencies so this comparison remains reproducible for the
 * external crypto review required before the first pilot.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Best-effort version lookup that tolerates a missing `./package.json` export. */
function packageVersion(name: string): string {
  try {
    const p = require.resolve(`${name}/package.json`)
    return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version
  } catch {
    let dir = dirname(require.resolve(name))
    for (;;) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        return (JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }).version
      }
      const parent = dirname(dir)
      if (parent === dir) return 'unknown'
      dir = parent
    }
  }
}

export type CanonicalizeFn = (value: unknown) => string

export type CanonicalizerCandidate = {
  /** Package name as published on npm. */
  readonly id: string
  /** Installed version, read from the resolved package. */
  readonly version: string
  readonly canonicalize: CanonicalizeFn
  /** One-line justification used in the decision record. */
  readonly note: string
}

/** Unwrap either a default or a named `canonicalize` export. */
function unwrap(mod: unknown, fallbackKey: string): CanonicalizeFn {
  if (typeof mod === 'function') return mod as CanonicalizeFn
  const asRecord = mod as Record<string, unknown>
  const picked = asRecord['canonicalize'] ?? asRecord['default'] ?? asRecord[fallbackKey]
  if (typeof picked !== 'function') {
    throw new Error(`could not find a canonicalize function on module (keys: ${Object.keys(asRecord).join(', ')})`)
  }
  return picked as CanonicalizeFn
}

export async function loadCandidates(): Promise<readonly CanonicalizerCandidate[]> {
  const [canonicalizeMod, jsonCanonicalizeMod, jsonFreezeMod] = await Promise.all([
    import('canonicalize'),
    import('json-canonicalize'),
    import('json-freeze'),
  ])

  return [
    {
      id: 'canonicalize',
      version: packageVersion('canonicalize'),
      canonicalize: unwrap(canonicalizeMod, 'canonicalize'),
      note: 'Named in RFC 8785 Appendix G as a verified-compatible JavaScript implementation.',
    },
    {
      id: 'json-canonicalize',
      version: packageVersion('json-canonicalize'),
      canonicalize: unwrap(jsonCanonicalizeMod, 'canonicalize'),
      note: 'Established alternative, widely used for JWK thumbprints (RFC 7638).',
    },
    {
      id: 'json-freeze',
      version: packageVersion('json-freeze'),
      canonicalize: unwrap(jsonFreezeMod, 'canonicalize'),
      note: 'Named by the V1 handoff. Single maintainer, single release, no subsequent commits.',
    },
  ]
}

export type ProbeOutcome =
  | { readonly kind: 'returned'; readonly output: string }
  | { readonly kind: 'threw'; readonly message: string }

/**
 * Run one input and report whether it returned or threw, without leaking the
 * exception. Error semantics matter as much as output bytes here: silently
 * mapping a non-JSON value onto something JSON-shaped would let the notary
 * attest to something the caller never sent.
 */
export function probe(fn: CanonicalizeFn, value: unknown): ProbeOutcome {
  try {
    return { kind: 'returned', output: fn(value) }
  } catch (error) {
    return { kind: 'threw', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

/** Inputs a conformant RFC 8785 canonicalizer MUST reject (RFC 8785 3.1, 3.2.2.2, 3.2.2.3). */
export function mustRejectInputs(): readonly { readonly label: string; readonly value: unknown }[] {
  const circular: Record<string, unknown> = {}
  circular['self'] = circular

  return [
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'BigInt', value: 1n },
    { label: 'undefined value in object', value: { a: undefined } },
    { label: 'function value in object', value: { a: () => 1 } },
    { label: 'symbol value in object', value: { a: Symbol('s') } },
    { label: 'circular reference', value: circular },
    { label: 'lone high surrogate string', value: '\ud800' },
    { label: 'lone high surrogate in key', value: { '\ud800': 1 } },
  ]
}
