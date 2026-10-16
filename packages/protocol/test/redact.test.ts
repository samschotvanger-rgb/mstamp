/**
 * Redaction tests.
 *
 * Redaction is a privacy control that runs BEFORE hashing, so its behaviour is
 * part of the cryptographic record: the hash covers the redacted form, and the
 * receipt's `registration` field is how that is disclosed. A missed field here
 * leaks buyer data; an over-eager one silently invalidates a buyer's own
 * validation rules.
 *
 * The no-mutation tests matter as much as the redaction ones: the SDK runs
 * inline with a live application, so mutating a caller's object would corrupt
 * the buyer's own data as a side effect of telemetry.
 */

import { describe, expect, it } from 'vitest'

import {
  REDACTED,
  redactBody,
  redactHeaders,
  redactUrl,
  type RedactionPolicy,
} from '../src/redact.js'

describe('redactHeaders', () => {
  it('always strips the headers the original spec names', () => {
    const out = redactHeaders({
      authorization: 'Bearer sk_live_abc',
      cookie: 'session=xyz',
      'set-cookie': 'a=b',
      'x-api-key': 'key123',
      'proxy-authorization': 'Basic zzz',
    })
    expect(out).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      'x-api-key': REDACTED,
      'proxy-authorization': REDACTED,
    })
  })

  it('strips any header matching the sensitive pattern, case-insensitively', () => {
    const out = redactHeaders({
      Authorization: 'x',
      'X-Auth-Token': 'x',
      'X-Secret': 'x',
      'My-Password': 'x',
      'API-KEY': 'x',
      'X-Credential-Key': 'x',
      'x-amz-security-token': 'x',
    })
    for (const value of Object.values(out)) expect(value).toBe(REDACTED)
  })

  it('preserves headers that carry no secret', () => {
    const out = redactHeaders({
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'mstamp-sdk/0.1.0',
      'x-request-id': 'req_123',
      'cache-control': 'no-cache',
    })
    expect(out).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'mstamp-sdk/0.1.0',
      'x-request-id': 'req_123',
      'cache-control': 'no-cache',
    })
  })

  it('does not mutate the input headers', () => {
    const input = { authorization: 'Bearer secret', accept: 'application/json' }
    const snapshot = { ...input }
    redactHeaders(input)
    expect(input).toEqual(snapshot)
  })

  it('honours a custom header policy', () => {
    const policy: RedactionPolicy = { headerNames: ['x-tenant'], headerPattern: null }
    const out = redactHeaders({ 'x-tenant': 'acme', authorization: 'Bearer x' }, policy)
    // With the pattern disabled only the explicit name is stripped.
    expect(out).toEqual({ 'x-tenant': REDACTED, authorization: 'Bearer x' })
  })
})

describe('redactBody', () => {
  it('redacts the default field names at any depth', () => {
    const out = redactBody({
      user: { email: 'a@b.com', phone: '555', ssn: '123-45-6789' },
      payment: { credit_card: '4111111111111111' },
      auth: { password: 'hunter2', api_key: 'sk_1', token: 't_1' },
    })
    expect(out).toEqual({
      user: { email: REDACTED, phone: REDACTED, ssn: REDACTED },
      payment: { credit_card: REDACTED },
      auth: { password: REDACTED, api_key: REDACTED, token: REDACTED },
    })
  })

  it('matches common casing and separator variants of a policy key', () => {
    // `api_key`, `apiKey`, `api-key` and `API_KEY` all name the same secret, and
    // a redactor that only caught the exact spelling would leak the others.
    const out = redactBody({ apiKey: 'a', 'api-key': 'b', API_KEY: 'c', Api_Key: 'd', apikey: 'e' })
    expect(out).toEqual({ apiKey: REDACTED, 'api-key': REDACTED, API_KEY: REDACTED, Api_Key: REDACTED, apikey: REDACTED })
    expect(redactBody({ creditCard: 'x' })).toEqual({ creditCard: REDACTED })
  })

  it('redacts inside arrays', () => {
    const out = redactBody({ users: [{ email: 'a@b.com', name: 'A' }, { email: 'c@d.com', name: 'C' }] })
    expect(out).toEqual({ users: [{ email: REDACTED, name: 'A' }, { email: REDACTED, name: 'C' }] })
  })

  it('replaces a whole sensitive subtree rather than recursing into it', () => {
    const out = redactBody({ token: { nested: { deep: 'secret' } } })
    expect(out).toEqual({ token: REDACTED })
  })

  it('leaves non-matching fields and values untouched', () => {
    const out = redactBody({ items: [1, 2, 3], meta: { count: 3, ok: true, nothing: null } })
    expect(out).toEqual({ items: [1, 2, 3], meta: { count: 3, ok: true, nothing: null } })
  })

  it('does not redact a field that merely contains a policy word', () => {
    // Exact (normalised) name matching, not substring: `tokenCount` is a count,
    // not a secret. Over-redacting here would break a buyer's own rules.
    const out = redactBody({ tokenCount: 5, keywords: ['a'], monkey: 'x' })
    expect(out).toEqual({ tokenCount: 5, keywords: ['a'], monkey: 'x' })
  })

  it('passes primitives through', () => {
    expect(redactBody('plain')).toBe('plain')
    expect(redactBody(42)).toBe(42)
    expect(redactBody(null)).toBeNull()
    expect(redactBody(true)).toBe(true)
  })

  it('does not mutate the input object, at any depth', () => {
    const input = { user: { email: 'a@b.com', tags: ['x'] } }
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown
    redactBody(input)
    expect(input).toEqual(snapshot)
  })

  it('returns a structurally independent copy', () => {
    const input = { user: { email: 'a@b.com' } }
    const out = redactBody(input) as { user: { email: string } }
    out.user.email = 'changed'
    expect(input.user.email).toBe('a@b.com')
  })

  it('honours a custom body policy', () => {
    const out = redactBody({ employee_id: 'e1', email: 'a@b.com' }, { bodyKeys: ['employee_id'] })
    expect(out).toEqual({ employee_id: REDACTED, email: 'a@b.com' })
  })
})

describe('redactUrl', () => {
  it('redacts sensitive query parameters', () => {
    const out = redactUrl('https://api.example.com/v1/extract?api_key=sk_live_abc&q=shoes')
    expect(out).toContain('api_key=%3Credacted%3E')
    expect(out).toContain('q=shoes')
    expect(out).not.toContain('sk_live_abc')
  })

  it('redacts URL userinfo', () => {
    // Without this, credentials embedded in the URL would be stored verbatim in
    // the event's `request.url` - a leak the original spec's header/body rules miss.
    const out = redactUrl('https://user:s3cret@api.example.com/v1/extract')
    expect(out).not.toContain('s3cret')
    expect(out).toContain('api.example.com')
  })

  it('leaves a clean URL unchanged in meaning', () => {
    const out = redactUrl('https://api.example.com/v1/extract?q=shoes&page=2')
    expect(out).toContain('q=shoes')
    expect(out).toContain('page=2')
    expect(out).not.toContain(REDACTED)
  })

  it('returns unparseable input unchanged instead of throwing', () => {
    // Telemetry must never break the caller's request, even on malformed input.
    expect(redactUrl('not a url')).toBe('not a url')
  })
})
