/**
 * Guards against deploying with a published test key.
 *
 * The fixtures in `test/helpers/keys.ts` are 32 bytes of a single repeated value
 * (0x01 through 0x04). They are public on purpose: conformance vectors and pinned
 * digests need to be reproducible, so the seeds cannot be secret.
 *
 * That is exactly what makes them dangerous here. A service signing with 32 bytes of
 * 0x01 issues receipts that **anyone who has read this repository can forge**, and it
 * looks identical to a working deployment from the inside. Copying the test helper into
 * an environment file is one line away from total, silent compromise.
 *
 * Publishing this list costs nothing - the values are already in the test suite - so the
 * check is a guard against a mistake, not against a determined attacker. The escape
 * hatch exists because the suite must keep using those fixtures, and it is deliberately
 * an explicit, noisily-named variable rather than anything implicit.
 */

const SEED_BYTES = 32

/** The fills used by the test fixtures: 0x01, 0x02, 0x03, 0x04. */
const KNOWN_TEST_FILLS: readonly number[] = [1, 2, 3, 4]

const KNOWN_TEST_KEY_HEX: ReadonlySet<string> = new Set(
  KNOWN_TEST_FILLS.map((fill) => Buffer.from(new Uint8Array(SEED_BYTES).fill(fill)).toString('hex')),
)

/** True when `bytes` is one of the published test seeds. Constant work, no timing concern: this is a validity check, not an authentication. */
export function isKnownTestKey(bytes: Uint8Array): boolean {
  return KNOWN_TEST_KEY_HEX.has(Buffer.from(bytes).toString('hex'))
}

/**
 * Whether the published fixtures are allowed.
 *
 * Must be exactly `1`. Anything else - including `true`, `yes`, `TRUE` - is ignored, so
 * an operator cannot enable this by accident or by half-remembering the value.
 */
export function testKeysAllowed(env: Record<string, string | undefined>): boolean {
  return env['MSTAMP_ALLOW_TEST_KEYS']?.trim() === '1'
}
