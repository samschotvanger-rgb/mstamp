/**
 * Service configuration - the "refuse to start" gate.
 *
 * A backend that cannot sign cannot produce a verifiable receipt: every ingest would
 * fail, and the only symptom would be an empty database. So these tests are about
 * failing early, loudly, and with a message specific enough to fix without guessing.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_PORT, loadServiceConfig as loadServiceConfigRaw } from '../src/config.js'
import { MasterKeyError } from '../src/crypto/encrypt.js'
import { SigningKeyError, publicKeyBase64 } from '../src/crypto/sign.js'
import {
  TEST_KEY_ID,
  TEST_MASTER_KEY,
  TEST_MASTER_KEY_BASE64,
  TEST_SEED_BASE64,
  testSigningKey,
} from './helpers/keys.js'

const DATABASE_URL = 'postgres://mstamp:secret@localhost:5432/mstamp'

/**
 * Every test below uses the published fixture keys, which the service refuses by
 * default. Setting the override once here keeps 24 call sites readable; the guard tests
 * near the bottom call `loadServiceConfigRaw` to prove the refusal is real.
 *
 * A key id is supplied here too, because there is no default any more. Tests that care
 * about its absence override it with `undefined`.
 */
const loadServiceConfig = (
  env: Record<string, string | undefined>,
): ReturnType<typeof loadServiceConfigRaw> =>
  loadServiceConfigRaw({
    MSTAMP_ALLOW_TEST_KEYS: '1',
    MSTAMP_SIGNING_KEY_ID: TEST_KEY_ID,
    ...env,
  })

describe('loadServiceConfig', () => {
  it('loads a valid configuration', async () => {
    const config = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })

    expect(config.databaseUrl).toBe(DATABASE_URL)
    expect(config.signingKey.keyId).toBe(TEST_KEY_ID)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.signingKey.publicKey).toHaveLength(32)
  })

  it('derives the same public key as signingKeyFromSeed', async () => {
    const config = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })
    const expected = await testSigningKey(TEST_KEY_ID)

    expect(publicKeyBase64(config.signingKey)).toBe(publicKeyBase64(expected))
  })

  // -------------------------------------------------------------------------
  // Refuses to start
  // -------------------------------------------------------------------------

  it('refuses to start when the signing key is missing', async () => {
    await expect(loadServiceConfig({ DATABASE_URL })).rejects.toBeInstanceOf(SigningKeyError)
    await expect(loadServiceConfig({ DATABASE_URL })).rejects.toThrow(/MSTAMP_SIGNING_KEY is required/)
  })

  it('refuses to start when the signing key is blank', async () => {
    for (const value of ['', '   ', '\t']) {
      await expect(
        loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: value }),
        `value ${JSON.stringify(value)}`,
      ).rejects.toThrow(/MSTAMP_SIGNING_KEY is required/)
    }
  })

  it('refuses to start when the signing key is malformed', async () => {
    const cases: [string, string][] = [
      ['not base64 at all', 'not-base64!!!'],
      ['valid base64 but 16 bytes', Buffer.from(new Uint8Array(16).fill(1)).toString('base64')],
      ['valid base64 but 64 bytes', Buffer.from(new Uint8Array(64).fill(1)).toString('base64')],
      ['truncated', TEST_SEED_BASE64.slice(0, 20)],
    ]

    for (const [label, value] of cases) {
      await expect(
        loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: value }),
        label,
      ).rejects.toBeInstanceOf(SigningKeyError)
    }
  })

  it('names the expected length when the key decodes to the wrong size', async () => {
    // The message has to be actionable: "32 bytes" tells the operator they pasted a
    // public key, a passphrase, or a truncated string.
    const sixteen = Buffer.from(new Uint8Array(16).fill(7)).toString('base64')

    await expect(loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: sixteen })).rejects.toThrow(/32 bytes/)
  })

  it('requires DATABASE_URL', async () => {
    await expect(loadServiceConfig({ MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })).rejects.toThrow(/DATABASE_URL is required/)
  })

  it('rejects a PORT that is not a valid port', async () => {
    for (const port of ['0', '70000', 'abc', '80.5', '-1']) {
      await expect(
        loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64, PORT: port }),
        `PORT ${port}`,
      ).rejects.toThrow(/PORT must be an integer/)
    }
  })

  // -------------------------------------------------------------------------
  // Tolerance that is safe
  // -------------------------------------------------------------------------

  it('honours MSTAMP_SIGNING_KEY_ID', async () => {
    const config = await loadServiceConfig({
      DATABASE_URL,
      MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64,
      MSTAMP_SIGNING_KEY_ID: TEST_KEY_ID,
    })

    expect(config.signingKey.keyId).toBe(TEST_KEY_ID)
  })

  it('refuses to start without MSTAMP_SIGNING_KEY_ID', async () => {
    // No default on purpose: a receipt names its signing key only by this id, so two
    // deployments sharing one cannot be told apart by a verifier.
    await expect(
      loadServiceConfig({
        DATABASE_URL,
        MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64,
        MSTAMP_SIGNING_KEY_ID: undefined,
      }),
    ).rejects.toThrow(/MSTAMP_SIGNING_KEY_ID is required/)
  })

  it('refuses a blank MSTAMP_SIGNING_KEY_ID', async () => {
    for (const value of ['', '   ', '\t']) {
      await expect(
        loadServiceConfig({
          DATABASE_URL,
          MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64,
          MSTAMP_SIGNING_KEY_ID: value,
        }),
        `value ${JSON.stringify(value)}`,
      ).rejects.toThrow(/MSTAMP_SIGNING_KEY_ID is required/)
    }
  })

  it('accepts base64url, which operators paste just as often', async () => {
    const standard = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })
    const base64url = TEST_SEED_BASE64.replace(/\+/g, '-').replace(/\//g, '_')
    const fromUrlSafe = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: base64url, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })

    expect(publicKeyBase64(fromUrlSafe.signingKey)).toBe(publicKeyBase64(standard.signingKey))
  })

  it('tolerates surrounding whitespace, which shells and dotenv love to add', async () => {
    const config = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: `  ${TEST_SEED_BASE64}\n`, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })
    const expected = await testSigningKey(TEST_KEY_ID)

    expect(publicKeyBase64(config.signingKey)).toBe(publicKeyBase64(expected))
  })

  it('parses an explicit PORT', async () => {
    const config = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64, PORT: '8081' })

    expect(config.port).toBe(8081)
  })

  it('records NODE_ENV, defaulting to development', async () => {
    const dev = await loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })
    const prod = await loadServiceConfig({
      DATABASE_URL,
      MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64,
      NODE_ENV: 'production',
    })

    expect(dev.nodeEnv).toBe('development')
    expect(prod.nodeEnv).toBe('production')
  })

  // -------------------------------------------------------------------------
  // The payload encryption master key
  // -------------------------------------------------------------------------

  it('refuses to start without MSTAMP_MASTER_KEY, in any mode', async () => {
    // Required in every mode, including a local-only deployment. A service that started
    // without it would accept a `full`-registration event and then fail to store its
    // preview, which surfaces as a per-event `rejected` count rather than as the
    // configuration mistake it is.
    const env = { DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64 }

    await expect(loadServiceConfig(env)).rejects.toBeInstanceOf(MasterKeyError)
    await expect(loadServiceConfig(env)).rejects.toThrow(/MSTAMP_MASTER_KEY is required/)
  })

  it('refuses to start when the master key is blank', async () => {
    for (const value of ['', '   ', '\t']) {
      await expect(
        loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: value }),
        `value ${JSON.stringify(value)}`,
      ).rejects.toThrow(/MSTAMP_MASTER_KEY is required/)
    }
  })

  it('refuses to start when the master key is malformed', async () => {
    const cases: [string, string][] = [
      ['not base64', 'not-base64!!!'],
      ['16 bytes', Buffer.from(new Uint8Array(16).fill(9)).toString('base64')],
      ['64 bytes', Buffer.from(new Uint8Array(64).fill(9)).toString('base64')],
    ]

    for (const [label, value] of cases) {
      await expect(
        loadServiceConfig({ DATABASE_URL, MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_MASTER_KEY: value }),
        label,
      ).rejects.toBeInstanceOf(MasterKeyError)
    }
  })

  it('reads the master key as 32 raw bytes', async () => {
    const config = await loadServiceConfig({
      DATABASE_URL,
      MSTAMP_SIGNING_KEY: TEST_SEED_BASE64,
      MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64,
    })

    expect(config.masterKey).toHaveLength(32)
    expect(Array.from(config.masterKey)).toEqual(Array.from(TEST_MASTER_KEY))
  })

  // -------------------------------------------------------------------------
  // Refusing the published fixtures
  //
  // Anyone can run this service from the repository, so the fixtures that make the
  // test vectors reproducible are also a forgeable signing key. These tests pin the
  // guard that stops a deployer copying them out of `test/helpers/keys.ts`.
  // -------------------------------------------------------------------------

  const REAL_SEED = Buffer.from(new Uint8Array(32).fill(0x2a)).toString('base64')
  const REAL_MASTER_KEY = Buffer.from(new Uint8Array(32).fill(0x2b)).toString('base64')

  function rawEnv(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      DATABASE_URL,
      MSTAMP_SIGNING_KEY: REAL_SEED,
      MSTAMP_SIGNING_KEY_ID: TEST_KEY_ID,
      MSTAMP_MASTER_KEY: REAL_MASTER_KEY,
      ...overrides,
    }
  }

  it('refuses to start with the published test signing key', async () => {
    await expect(
      loadServiceConfigRaw(rawEnv({ MSTAMP_SIGNING_KEY: TEST_SEED_BASE64 })),
    ).rejects.toThrow(/published test fixture/)
  })

  it('refuses to start with the published test master key', async () => {
    // A known master key means known per-tenant payload keys, so every stored preview
    // would be readable by anyone who has read the repository.
    await expect(
      loadServiceConfigRaw(rawEnv({ MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64 })),
    ).rejects.toThrow(/published test fixture/)
  })

  it('allows the fixtures only behind the exact override', async () => {
    await expect(
      loadServiceConfigRaw(
        rawEnv({
          MSTAMP_SIGNING_KEY: TEST_SEED_BASE64,
          MSTAMP_MASTER_KEY: TEST_MASTER_KEY_BASE64,
          MSTAMP_ALLOW_TEST_KEYS: '1',
        }),
      ),
    ).resolves.toBeDefined()

    // Anything other than exactly "1" leaves the guard in place, so an operator cannot
    // enable it by half-remembering the value.
    for (const value of ['true', 'yes', '0', '']) {
      await expect(
        loadServiceConfigRaw(
          rawEnv({ MSTAMP_SIGNING_KEY: TEST_SEED_BASE64, MSTAMP_ALLOW_TEST_KEYS: value }),
        ),
        `MSTAMP_ALLOW_TEST_KEYS=${JSON.stringify(value)}`,
      ).rejects.toThrow(/published test fixture/)
    }
  })

  it('does not mistake a real key for a fixture', async () => {
    await expect(loadServiceConfigRaw(rawEnv())).resolves.toBeDefined()
  })
})
