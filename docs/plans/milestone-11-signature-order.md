# ExecPlan — Milestone 11: Signature + Immutable Order

Status: implemented on `claude/milestone-11-signature-order`.
Strategy context: `docs/strategy/REVENUE_OPERATIONS.md` §2, `EXECUTION_ROADMAP.md` M11.
Builds directly on Milestone 10 (ADR-016): the immutable Quote Version is the
artifact this milestone consumes.

## Outcome

```text
approved Quote Version
  → request signature (human user actor)
  → provider envelope (external call, outside every transaction)
  → verified signature events (provider-signed, replay-proof)
  → completed signed-artifact evidence
  → ONE immutable Order + Order Lines / Components / Tiers / Totals
```

The Order is built **from the approved Quote Version snapshot**, never from the
live catalog. A later catalog, offer, tier or product change cannot alter the
signed artifact evidence or the Order.

## Out of scope (deliberate)

Real DocuSign / Adobe Sign / Dropbox Sign credentials or APIs, production PDF
generation, legally qualified signature assurance, payments, billing,
invoicing, tax, FX, revenue recognition, fulfillment, Delivery/Service,
cancellation, refunds, order amendments, renewals, a background job scheduler,
a generic workflow or document DSL, a durable distributed outbox,
authentication, tenancy, RBAC, PostgreSQL, Cloud code, remote MCP, telemetry.

## Three architectures compared

1. **Direct provider call inside a normal transactional action.** One code
   path, trivially "atomic" — and wrong. It holds the SQLite write lock open
   across a network round trip (every other writer blocks for the provider's
   latency), and it *cannot* be atomic anyway: if the provider creates the
   envelope and the local commit then fails, the local database has no record
   of a real external object. It also encourages the lie that local and remote
   state commit together. **Rejected.**

2. **A generic external-workflow / side-effect DSL.** Maximum future
   flexibility, and far too much surface for one milestone: a declarative
   retry/compensation language is a framework of its own, is hard to make
   fail-closed, and would be exercised by exactly one provider. It also
   conflicts with the repository's code-first, bounded-contract direction.
   **Rejected.**

3. **A bounded signature provider contract plus a persisted envelope/event
   state machine with explicit reconciliation (chosen).** The provider contract
   is a small versioned, fingerprinted definition (ADR-015 mechanism). Local
   state is a persisted envelope with a monotonic status, an append-only
   verified-event inbox, and an explicit `reconcile` operation that re-queries
   the provider by a deterministic idempotency key. Every remote call happens
   **outside** every database transaction, between two local transactions.

## The external-operation contract (new, smallest possible)

The M10 action runtime supports `prepare` (read-only, outside the transaction)
plus **one** write transaction. A signature request needs **two** write
transactions around a remote call, so the runtime gains one bounded shape —
not a DSL, and not arbitrary transaction control:

```text
externalOperation: 1

  intent(ctx)    → runs inside transaction A (fromStates checked here)
  external(ctx)  → runs OUTSIDE every transaction, under a bounded timeout;
                   ctx has NO database, NO modules, NO managed — only the
                   frozen JSON-safe value intent returned, the input, the
                   actor and the registry lookup it declares
  finalize(ctx)  → runs inside transaction B
  compensate(ctx)→ runs inside transaction C only when external/finalize failed
```

`packages/core/src/external-operation.js` implements this once and is shared by
the action runtime (`quote.request-signature`) and the two app-level signature
operations (event ingestion, reconciliation), so all three produce the same
audit/event/trace envelope: buffered events per transaction, dispatch after the
commit, one trace run with `…intent`, `…external`, `…finalize` /
`…compensate` spans.

**No claim of atomicity across the local database and the remote provider is
made anywhere.** The recovery story is the state machine plus reconciliation.

## Records (all read-only publicly, `['get','list']`)

| Module | Purpose |
|---|---|
| `signature-envelope` | one envelope per Quote Version, monotonic status, provider identity, idempotency key, document hash |
| `signature-signer` | immutable signer snapshot with per-signer status |
| `signature-event` | append-only verified-event inbox, DB-unique provider event id |
| `signed-artifact` | completion evidence: hashes, provider artifact reference, metadata |
| `order` | one immutable Order per completed signed Quote Version |
| `order-line` | immutable line snapshot copied from the version line |
| `order-component` | immutable component definition + tier schedule + band breakdown |
| `order-tier` | immutable tier row of an order component |
| `order-total` | one one-time total row plus one per `(currency, interval, intervalCount)` |

## Envelope state machine

```text
preparing ──▶ sent ──▶ delivered ──▶ completed   (terminal)
    │           │           └──────▶ declined    (terminal)
    │           └──────────────────▶ voided      (terminal)
    └──▶ failed ──(reconcile only)──▶ sent | delivered | completed | declined | voided
```

Transitions come from an **explicit allowed-transition table** (corrected in
the adversarial review — a numeric rank cannot express branching terminals, and
would treat `completed → declined` as equal): the table is published in
`/api/schema` and asserted pair by pair. `completed`, `declined` and `voided`
are terminal and can never regress — a late `sent` or a duplicate `completed`
is recorded in the inbox and ignored. `failed` is the one recoverable
non-terminal state: it means *the local side failed*, the provider
may or may not hold an envelope, and `reconcile` is the documented recovery.

**Exactly one envelope per Quote Version, ever** — enforced by the DB-unique
source key `env:quote-version:<quoteVersionId>`, which is also the deterministic
idempotency key given to the provider. A repeated request can therefore never
create a second provider envelope; it is refused with `409 ENVELOPE_EXISTS`
pointing at reconciliation.

## Signer semantics (v1, documented and narrow)

All signers are required; ordering is **parallel** (the declared `order` is
recorded and shown, not enforced as sequential gating); 1–5 signers; no
conditional routing, no reminders, no delegation. Signer identity assurance is
**not** claimed — only the provider's own evidence is recorded.

## Document package

A deterministic canonical JSON document is derived from the approved Quote
Version: quote/version identity, parties, offer and product-version snapshot,
every component with its tier schedule and band breakdown, grouped totals, the
discount-policy decision, and the signer list. One deterministic serializer
emits the canonical bytes, the SHA-256 covers exactly those bytes, and exactly
those bytes are sent. Parties are snapshotted at request time so the package
stays reproducible; the rebuild is re-checked before an Order is created. It is
**not** a PDF and is never called one.

## Order creation atomicity

The verified `completed` transition performs, in **one** transaction:
envelope → `completed`, signer completion evidence, `signed-artifact`, `order`,
order lines, components, tiers and totals copied from the Quote Version
snapshot, the managed links on quote/envelope, and the audits/events. Any
failure rolls all of it back and leaves the inbox row unprocessed, so
reconciliation can complete it later. Artifact metadata that requires a
provider call is fetched in the `external` phase, before that transaction
opens. `order:quote-version:<id>` is DB-unique, so duplicate or concurrent
completions can only ever produce one Order.

## Event ingestion

`POST /api/signature/providers/:provider/events` is a dedicated route with the
**raw body preserved**, bounded to 64 KiB. Verification (HMAC-SHA256 with
constant-time comparison plus a ±300 s timestamp window) happens before any
state is touched; failures are a stable `401 SIGNATURE_INVALID` that never
echoes the payload, the signature or the key. The fixture verification key is
declared test-only in checked-in source and is documented as **not** production
webhook security — real secret management is Production Spine work.

## Corrected in the adversarial review

1. **A terminal answer from `createEnvelope` now completes properly.** Persisting `completed` without the artifact and the Order was unrecoverable, because terminal states never transition again. Finalization routes every provider state through the same path a webhook uses, and the artifact is prefetched in `external`.
2. **The signed package is rebuilt from snapshots, not live CRM rows.** Parties are snapshotted at request time; a customer rename previously blocked completion forever with `DOCUMENT_HASH_MISMATCH`.
3. **The hash covers the exact bytes sent**, produced by one deterministic serializer with no `localeCompare` anywhere.
4. **A provider envelope must prove it is ours** (document hash + signer set + known provider id) before adoption: `409 PROVIDER_ENVELOPE_MISMATCH`.
5. **Transitions come from an explicit table**, published in the schema — a rank cannot express branching terminals.
6. **Replay scope is provider + event id + payload fingerprint**; a reused id with different bytes is `409 EVENT_ID_CONFLICT`, and an event whose processing failed is **resumed** on redelivery instead of being stranded as a duplicate.
7. **Quarantined events are linked and recoverable**, so an early completion is never silently lost.
8. **Webhook bytes stay bytes** end to end; the bound is a real 64 KiB.
9. **The Order snapshots its customer**, and the signed canonical document travels with the artifact, so the Order reads independently of catalog, quote and CRM rows.
10. **`artifactHash` is documented as provider-reported**; no artifact byte is downloaded, hashed or cryptographically verified.
11. **`PROVIDER_ENVELOPE_ABSENT` is distinguished from an unknown outcome**, and the Admin states which of the three cases applies.

## Verification

`npm run verify`, `npm run smoke`, the starter twice from a clean project, and
the real-Chromium harness. The full failure matrix (provider outage, timeout,
invalid payload, local finalization failure, lost webhook, duplicate webhook,
out-of-order events, concurrent completion vs reconcile, restart) is covered by
`tests/signature-contract.test.js` and `tests/signature-order-e2e.test.js`.
