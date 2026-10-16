# Security Policy

mstamp produces cryptographic evidence, so a flaw here does not merely break a
feature — it can make a receipt assert something untrue while still verifying. We
would rather hear about a suspected flaw early and be wrong than not hear about it.

## Reporting a vulnerability

Report privately using GitHub's [private vulnerability reporting][pvr]: open the
**Security** tab of this repository and choose **Report a vulnerability**. Please
do not open a public issue for anything you believe is exploitable.

A useful report includes:

- the commit or version you tested,
- the smallest reproduction you can manage,
- what an attacker gains, and who they have to be (a tenant? the provider? an
  anonymous third party holding only a receipt and a public key?).

This is an early-stage project without a security team or an on-call rotation.
You will get an acknowledgement and an honest assessment, not a guaranteed
response time. There is no bug bounty.

## In scope

- **Receipt forgery or alteration.** Producing a receipt that verifies against a
  published public key but was not signed by the service, or modifying a signed
  receipt such that it still verifies.
- **Canonicalization divergence.** Any input where this implementation's
  canonical bytes disagree with RFC 8785 as implemented by an independent
  third party. Two verifiers that disagree about the same receipt are the worst
  failure mode this protocol has, because both will report success.
- **Hash ambiguity.** Two distinct inputs producing the same `requestHash` or
  `responseHash` other than through a genuine SHA-256 collision — for example by
  a decoding or normalization step that collapses distinct byte sequences.
- **Tenant isolation bypass.** Any way for one tenant to read, modify, or infer
  another tenant's receipts or stored payloads. Row-level security is the
  boundary; a query that escapes it is a vulnerability even if it requires
  application-level cooperation.
- **Key material exposure.** Reading the signing key or master key through the
  API, logs, error messages, or a stored payload.
- **Authentication bypass** on any `/v1` route.

## Known and accepted limitations

These are documented rather than fixed. Reporting them again is welcome if you
think the impact is worse than described, but they are not surprises.

- **A leaked signing key can forge backdated receipts.** Signatures prove
  authorship, not time. An attacker holding the key can mint any receipt with any
  timestamp. Timestamping (RFC 3161) is the intended fix and is not implemented.
- **Low-entropy responses are dictionary-attackable.** A `responseHash` over a
  small, predictable body such as `{"status":"ok"}` can be brute-forced to
  confirm what the provider returned. Hashing is not encryption.
- **A response larger than the 1 MB cap is not covered by the receipt.** Over the
  cap the receipt records `sentinel:oversize` and no hash at all, rather than a
  partial or fabricated digest.
- **A failed fetch produces no receipt.** If the provider is unreachable there
  are no response bytes to attest to, so a buyer cannot use mstamp to prove an
  outage.
- **`requestHash` is over a redacted, canonicalized projection**, not the exact
  bytes that left the process. A receipt proves a request contained certain
  non-secret fields; it does not prove the wire bytes the provider received.
- **Rule paths cannot address keys containing `.` or `:`.** Such a key is
  unreachable by a validation rule. There is no escape syntax.

## Handling of secrets

No signing key, API key, or payload key is committed to this repository, and
`.env` files, `*.pem`, and `*.key` are git-ignored. The key material in the test
suite is fixed, publicly known, and used only to make signing bytes reproducible.

[pvr]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability
