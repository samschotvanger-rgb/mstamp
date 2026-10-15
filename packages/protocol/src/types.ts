/**
 * The Notched wire protocol.
 *
 * These types are the contract between three separately-deployed pieces: the
 * buyer's in-process SDK, the Notched backend, and (later) an offline verifier
 * running on a third party's machine. They live in `@notched/protocol` rather
 * than in the SDK so that the backend cannot quietly develop a different idea of
 * what a receipt is.
 *
 * Field names and shapes here are taken verbatim from the V1 handoff. Where this
 * file deviates, it says so in a comment.
 */

/** A JSON value, as defined by RFC 8259. Used to keep payloads honest. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * How much of the call was transmitted to the Notched backend.
 *
 * Recorded on every receipt because it bounds what the receipt can prove: a
 * `hash-only` receipt can demonstrate the response changed, but not what it
 * changed to. Backends count these rates per tenant so any published scorecard
 * can disclose its own confidence instead of overclaiming.
 */
export type Registration = 'full' | 'hash-only' | 'local'

/**
 * Who vouches for the receipt.
 *
 * - `self`       written locally by the buyer's SDK; nobody countersigned it
 * - `platform`   signed by the Notched backend (V1 cloud mode)
 * - `bilateral`  seller co-signed (V2)
 * - `notarized`  hardware-attested (V3+)
 */
export type Attestation = 'self' | 'platform' | 'bilateral' | 'notarized'

/** Outcome of buyer-declared validation. `null` means no validation could run. */
export type ValidationResult = {
  /** `true`/`false` when rules ran; `null` when nothing was validated (e.g. non-JSON body). */
  passed: boolean | null
  /** Rule ids that were applied, e.g. `"min-length:items:1"`. */
  rules: string[]
  /** Human-readable failure descriptions, safe to show a buyer directly. */
  errors: string[]
}

/**
 * Version of the receipt schema. `"1"` is V1.
 *
 * This lives INSIDE the signed payload. A verifier must know which field set to
 * expect before it can canonicalize anything, and a version a forger could
 * rewrite would let them reinterpret the whole receipt. Extend the union when a
 * future schema lands; note that changing the signed field set changes the signed
 * bytes, which is exactly why the version is signed rather than inferred.
 */
export type SchemaVersion = '1'

/**
 * A Notched Receipt: the portable artefact.
 *
 * Reserved V2 fields (`anomaly`, `buyerOverride`) are present and always `null`
 * in V1. They exist now so that a V2 backend can start populating them without
 * invalidating receipts already in the wild - adding a field later would change
 * the canonical bytes and break every existing signature.
 */
export type Receipt = {
  /** Receipt schema version. `"1"` is the V1 field set; see `docs/receipt-schema.md`. */
  schemaVersion: SchemaVersion
  /** `"rcpt_" + nanoid` */
  receiptId: string
  /** `"tnt_" + nanoid`. Required: a receipt always belongs to exactly one tenant. */
  tenantId: string
  /** `"slr_" + nanoid`, or `null`. Always `null` in V1 (no seller co-signing). */
  sellerId: string | null
  /** Which provider was called, e.g. `"scraper-x"`. */
  provider: string
  /** Which operation, e.g. `"extract"`. */
  operation: string
  /** `"sha256:" + lowercase hex` over the canonicalised, redacted request body. */
  requestHash: string
  /** `"sha256:" + lowercase hex` over the response body bytes exactly as received. */
  responseHash: string
  statusCode: number
  latencyMs: number
  /** ISO 8601 UTC. */
  timestamp: string
  registration: Registration
  attestation: Attestation
  validation: ValidationResult
  /** Reserved for V2 (Jev anomaly detection). Always `null` in V1. */
  anomaly: null
  /** Reserved for V2 (buyer override of a validation verdict). Always `null` in V1. */
  buyerOverride: null
  sdkVersion: string
  /**
   * Identifier of the Ed25519 key the backend signed with, e.g. `"k_0001"`, or
   * `null` when the receipt has no signature.
   *
   * A verifier resolves this against `GET /v1/keys`, which publishes every key the
   * server has ever used and NEVER deletes one, so a receipt signed years ago
   * stays verifiable rather than becoming unverifiable the moment the signing key
   * is rotated.
   *
   * `null` means "no signing key", matching `serverSignature` and `signedAt`: a
   * local, unsigned receipt has no key and must not carry a fabricated id. All
   * three fields follow one rule - absent is `null`, never a magic empty string or
   * a stand-in value.
   *
   * Filled in at signing time. Because it is inside the signed payload but only
   * the signer knows which key it will use, the SDK emits a draft with `null` and
   * the backend stamps the key before canonicalizing. An SDK draft is therefore
   * deliberately NOT byte-identical to the signed receipt.
   *
   * Inside the signed payload on purpose: a key id a forger could rewrite would
   * let them choose which published key their forged signature is checked
   * against.
   */
  keyId: string | null
  /**
   * `"ed25519:" + base64`, filled in by the backend.
   *
   * `null` for a locally-written receipt (`attestation: "self"`), which has no
   * signature.
   *
   * Amended from the handoff's `string` on 2026-10-13: "absent" is represented
   * explicitly rather than as a magic empty string, so a missing signature can
   * never be mistaken for a present-but-unparseable one.
   */
  serverSignature: string | null
  /** ISO 8601 UTC, filled in by the backend. `null` when the receipt is unsigned. */
  signedAt: string | null
}

/**
 * A receipt minus the two fields the signer supplies.
 *
 * This is the exact object the backend canonicalises and signs, and the exact
 * object an offline verifier must reconstruct before checking a signature. It is
 * derived with `Omit` rather than hand-written so the two can never disagree -
 * an extra or missing field here silently invalidates every signature.
 */
export type ReceiptSigningPayload = Omit<Receipt, 'serverSignature' | 'signedAt'>

// ---------------------------------------------------------------------------
// SDK -> backend ingestion
// ---------------------------------------------------------------------------

/** The observation payload the SDK sends to `POST /v1/ingest/batch`. */
export type IngestEvent = {
  /** `"evt_" + nanoid` */
  eventId: string
  /** Links this event to the receipt it produces. */
  receiptId: string
  /** ISO 8601 UTC. */
  timestamp: string
  /**
   * Wall-clock duration of the observed call, in milliseconds.
   *
   * Added after the V1 handoff was written. The receipt requires a `latencyMs`, and the
   * event schema did not carry one, so the backend had no way to reconstruct it - it
   * would have had to invent a number or store zero, and latency is a scorecard input.
   */
  latencyMs: number
  request: {
    method: string
    url: string
    /** Redacted before transmission; see `redactHeaders`. */
    headers: Record<string, string>
    /** `"sha256:" + lowercase hex` over the canonicalised, redacted body. */
    bodyHash: string
    /** Redacted body text, or `null` in `hash-only`/`local` registration. */
    bodyPreview: string | null
  }
  response: {
    status: number
    /** Redacted before transmission; see `redactHeaders`. */
    headers: Record<string, string>
    /** `"sha256:" + lowercase hex` over the raw response bytes. */
    bodyHash: string
    /** Redacted body text, or `null` in `hash-only`/`local` registration. */
    bodyPreview: string | null
    contentType: string
  }
  validation: ValidationResult
  metadata: {
    provider: string
    operation: string
    sdkVersion: string
    environment: string
    registration: Registration
  }
}

/** Body of `POST /v1/ingest/batch`. */
export type IngestRequest = {
  /** Maximum 100 events per batch. */
  events: IngestEvent[]
}

/** Response from `POST /v1/ingest/batch`. */
export type IngestResponse = {
  accepted: number
  rejected: number
  /** `receiptId`s that were stored. */
  receipts: string[]
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Per-provider registration override, e.g. `{ "internal-pii-api": "hash-only" }`. */
export type RegistrationPolicy = Record<string, Registration>

/** Where the SDK writes receipts. */
export type TelemetryMode = 'local' | 'cloud'

/** Maximum events the backend accepts in one `IngestRequest`. */
export const MAX_EVENTS_PER_BATCH = 100
