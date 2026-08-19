# ExecPlan — signed-term integrity verifier (closes M-1)

**Status: in progress.** Branch `claude/signed-terms-integrity-verifier` from `e177431`
(M16b merged; ADR-035). Closes the Medium finding raised in the PR #89
independent review.

## The defect

The ADR-033 chain stores a `termsFingerprint` on every signed-term snapshot and
then **consumes the snapshot without ever recomputing it**. An out-of-band data
mutation — direct SQL; every public and HTTP write path is already closed —
therefore propagates through activation, `contract-lifecycle-source`, M16b
succession and Admin as *signed evidence*. Public bypass was never the issue;
**evidence integrity** is: a fingerprint nobody checks is a decoration.

Proven red-first on `e177431` (`tests/signed-terms-integrity.test.js`): mutate
`order_terms.term_end_date` while leaving `document_hash` intact and the
activated contract records the tampered date with
`termsSource: signed-order-terms`, `signed: true`.

## The authority, and where it stays

Term-fingerprint semantics belong to **Commercial**, which owns
`quote-version-term` and `signedTermFingerprint()`. The verifier lives there and
is reached only through a declared capability. **No fingerprint logic is
duplicated in Contracts, Signature or Lifecycle, and nothing moves into core.**

An `order-term` is a *copy* of a `quote-version-term`, so verifying one is two
checks, both Commercial's:

1. **self-consistency** — recompute the canonical fingerprint from the row's own
   values and compare to the `termsFingerprint` it carries;
2. **linkage** — compare those values field for field against the authoritative
   `quote-version-term` for the row's `quoteVersionId`.

Either failing is `TERMS_FINGERPRINT_MISMATCH` / `TERMS_SNAPSHOT_DIVERGED`, with
details naming **ids and field names only** — never the hostile values.

## Capability version decision

`packages/core/src/package-composition.js` keys offered capabilities
`name@version` (line 109) and `capability()` resolves the same key plus a
provider-identity cross-check, so **two versions of one capability name are
distinct keys and compose side by side** — verified by reading the registry, not
assumed.

The verifier introduces a **required method** and a **stronger guarantee**, so
under the doctrine recorded in ADR-036 it is a new capability version:
**`commercial-quotes@2`**. `@1` stays offered, byte-identical, for any consumer
that has not migrated; every in-repository consumer of signed terms moves to
`@2`. Version-mismatch checks are untouched.

## Consumption points (all must verify)

| # | Consumer | Boundary | Verifies |
|---|---|---|---|
| 1 | Signature `buildDocumentPackage` | before the document is canonicalized and hashed | `quote-version-term` self-consistency |
| 2 | Signature completion evidence | before `order-term` is written | the same snapshot, again inside the transaction |
| 3 | Contracts `loadActivationSource` | before activation reads terms as signed | `order-term` self-consistency **and** linkage |
| 4 | Contracts `contract-lifecycle-source@2` | before `signed: true` is derived | via 3 |
| 5 | M16b `planSuccession` / `executeSuccession` | before plan output and before any write | via 3 |
| 6 | Admin | renders only what 3–5 already verified | — |

A mismatch fails **before** business writes and before any provider call.

## Compatibility (an intentional tightening)

- no snapshot → unchanged historical behaviour, unsigned/operational/absent-unknown;
- valid snapshot → **byte-identical** outcome;
- invalid snapshot → **fails closed**, where it previously passed silently.

**No backfill, ever.** Nothing infers signed provenance from later operational dates.
