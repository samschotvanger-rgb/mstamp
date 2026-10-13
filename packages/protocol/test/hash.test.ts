/**
 * Hashing tests.
 *
 * The hash is what a receipt actually attests to, so it is verified against
 * published NIST/RFC SHA-256 vectors AND independently cross-checked against
 * Node's OpenSSL-backed `crypto` implementation. Two independent
 * implementations agreeing is the point: a bug in `@noble/hashes`, or a
 * mis-wired call into it, would otherwise be invisible.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { HASH_PREFIX, hashCanonicalJson, hashRawBytes, isHash, sha256Hex, sha256HexUtf8 } from '../src/hash.js'

const nodeSha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

describe('sha256Hex', () => {
  // Published SHA-256 test vectors (FIPS 180-4 / NIST examples).
  it('matches published vectors', () => {
    expect(sha256HexUtf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256HexUtf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256HexUtf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('agrees with Node crypto across varied inputs', () => {
    const inputs = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80]),
      Buffer.from('€ unicode — emoji 😂', 'utf8'),
      Buffer.alloc(1024, 0xab),
      Buffer.from(JSON.stringify({ a: [1, 2, 3] }), 'utf8'),
    ]
    for (const input of inputs) {
      expect(sha256Hex(input), `input length ${input.length}`).toBe(nodeSha256Hex(input))
    }
  })

  it('returns lowercase hex with no prefix of its own', () => {
    const hex = sha256HexUtf8('abc')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(hex).not.toContain(HASH_PREFIX)
  })
})

describe('hashRawBytes', () => {
  it('hashes raw bytes exactly as received, without decoding them', () => {
    // Response bodies are hashed before parsing, so a non-UTF-8 body (or one
    // that is not JSON at all) must still produce a stable, correct hash.
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])
    expect(hashRawBytes(raw)).toBe(`${HASH_PREFIX}${nodeSha256Hex(raw)}`)
  })

  it('distinguishes byte sequences that would collide once decoded', () => {
    // 0xEF 0xBF 0xBD is U+FFFD; decoding-and-re-encoding is lossy, so hashing
    // decoded text would make these two different bodies hash identically.
    const replacementChar = Buffer.from([0xef, 0xbf, 0xbd])
    const invalidByte = Buffer.from([0xff])
    expect(Buffer.from(replacementChar).toString('utf8')).toBe('\ufffd')
    expect(Buffer.from(invalidByte).toString('utf8')).toBe('\ufffd')
    expect(hashRawBytes(replacementChar)).not.toBe(hashRawBytes(invalidByte))
  })

  it('prefixes and formats as "sha256:<lowercase hex>"', () => {
    expect(hashRawBytes(new Uint8Array(0))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

describe('hashCanonicalJson', () => {
  it('is independent of property insertion order', () => {
    expect(hashCanonicalJson({ b: 1, a: 2 })).toBe(hashCanonicalJson({ a: 2, b: 1 }))
  })

  it('equals the hash of the canonical byte sequence', () => {
    const value = { z: 1, a: [true, null, 'x'] }
    const canonical = '{"a":[true,null,"x"],"z":1}'
    expect(hashCanonicalJson(value)).toBe(`${HASH_PREFIX}${nodeSha256Hex(Buffer.from(canonical, 'utf8'))}`)
  })

  it('distinguishes the unnormalised from the NFC-normalised form', () => {
    // Consequence of the canonicalization rule: NFD and NFC spellings of the
    // same glyph are different payloads and hash differently.
    expect(hashCanonicalJson({ k: 'A\u030a' })).not.toBe(hashCanonicalJson({ k: '\u00c5' }))
  })

  it('propagates I-JSON rejections rather than hashing a rewritten payload', () => {
    expect(() => hashCanonicalJson({ a: undefined })).toThrow()
    expect(() => hashCanonicalJson({ a: Number.NaN })).toThrow()
  })
})

describe('isHash', () => {
  it('accepts well-formed tagged hashes', () => {
    expect(isHash(`sha256:${'a'.repeat(64)}`)).toBe(true)
    expect(isHash(hashRawBytes(new Uint8Array([1])))).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isHash('sha256:' + 'A'.repeat(64))).toBe(false) // uppercase hex
    expect(isHash(`sha256:${'a'.repeat(63)}`)).toBe(false) // short
    expect(isHash(`sha256:${'a'.repeat(65)}`)).toBe(false) // long
    expect(isHash('a'.repeat(64))).toBe(false) // untagged
    expect(isHash('sha512:' + 'a'.repeat(64))).toBe(false) // wrong algorithm
    expect(isHash(null)).toBe(false)
    expect(isHash(123)).toBe(false)
  })
})
