# Decision log

Numbered decisions that constrain the build, recorded so the reasoning survives and does
not get re-litigated.

`D-005` and `D-010` are referenced from code comments and the README but predate this file:
they were ruled in the build instructions, so they are recorded here from that text rather
than reconstructed. Everything from D-013 onward is written when the decision is made.

---

## D-005 — `tenantId` defaults to `tnt_local`

A locally-written receipt needs a tenant id, and a local-only deployment has no backend to
supply one. The SDK defaults to the literal `tnt_local`.

In cloud mode the field is a placeholder on the local draft; the backend resolves the real
tenant from the API key at ingest. Recorded because it means a cloud-mode local row can
name a tenant that does not exist. That is fine — the row is a draft and the authoritative
receipt is the backend's — but it is worth knowing before reading the local database
directly.

## D-010 — response bodies are capped at 1 MB

`maxResponseBytes` defaults to `1_048_576`. Hashing raw response bytes requires reading all
of them, so without a cap interception would buffer an unbounded response on the caller's
behalf.

Over the cap, the read stops, the receipt carries `sentinel:oversize`, and the response is
**not hashed** — so a response larger than the cap is not covered by the receipt. That is
the accepted cost of the bound, and it is disclosed in `docs/receipt-schema.md`.

## D-013 — `IngestEvent` carries `latencyMs`

**Decided:** 2026-10-15.

`IngestEvent` gained a required top-level `latencyMs: number`.

**Rationale.** `Receipt.latencyMs` is a required field, and the event schema did not carry
one, so the backend had no way to reconstruct it. It would have had to write zero or invent
a number, and latency is a scorecard input — a fabricated value would corrupt every
provider scorecard built on it. The SDK already holds the real value: `intercept.ts`
measures the call and puts it on its own local receipt. The event was the only thing
missing it.

**Consequence: this is a breaking wire-format change.** An SDK built before this decision
and a backend built after it are mutually incompatible on ingest. The backend's event
validator rejects an event with no `latencyMs`, so a stale SDK sees `accepted: 0` with a
non-zero `rejected` count rather than an outright crash — a clear enough signal, but a
failure nonetheless.

**Accepted because no SDK has been distributed.** There are no deployed clients to migrate,
so changing the event shape today costs nothing, while shipping a placeholder latency and
fixing it later would cost a data migration plus a version negotiation. This is the last
cheap moment to correct it.
