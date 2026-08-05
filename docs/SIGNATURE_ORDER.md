# Signature and Order (Milestone 11, ADR-017)

Turning an approved Quote Version into a signed commitment and one immutable
Order — local development slice. **No real DocuSign, Adobe Sign or Dropbox
Sign integration exists or is claimed**; no production PDF, no legally
qualified signature assurance, no payment, billing, invoicing, tax, FX,
revenue recognition, fulfillment, cancellation, amendment or renewal.

## The flow

```text
approved Quote Version
→ request signature        human user actor only; one envelope per version, ever
→ provider envelope        the remote call happens OUTSIDE every transaction
→ verified events          provider-signed, replay-proof, append-only inbox
→ completed                signer evidence + signed artifact + ONE immutable Order
→ inspect                  envelope / signers / events / artifact / order / audit / trace
```

```js
await client.module('quote').action(quoteId, 'request-signature', {
  quoteVersionId,
  provider: 'fixture-signature',
  providerVersion: 1,
  signers: [{ name: 'Mario Rossi', email: 'mario@example.com', role: 'customer', order: 1 }],
});                                   // requires actor.type === 'user'

// the provider calls back, verified as the exact bytes it signed:
// POST /api/signature/providers/fixture-signature/events

await app.reconcileSignature({ envelopeId });   // explicit recovery, never scheduled
```

The Admin adds a **Signature** section to an approved quote (`#/quotes/<id>`):
one Request-signature control with its caveat, then read-only envelope,
signer, artifact and order evidence.

## Why two transactions, not one

A signature provider may accept a request and the local write may then fail; a
webhook may arrive twice, out of order, or never; a process may restart
mid-flight. The local database and a remote provider **cannot** commit
atomically, and this milestone never pretends otherwise. Instead an action may
declare the bounded external-operation shape (ADR-017):

```text
intent(ctx)     inside transaction A   — record the local intent
external(ctx)   OUTSIDE every transaction, bounded timeout, late settlement abandoned
finalize(ctx)   inside transaction B   — persist the remote outcome
compensate(ctx) its own transaction    — only when a later phase failed
```

The `external` context carries **no database, no modules and no managed
writes**: it sees the frozen JSON-safe value `intent` returned, the validated
input, the actor and the provider registry. Action code declares phases; it
never gains transaction control. One trace run records `…intent`,
`…external`, `…finalize` and `…compensate` spans, so local intent, the
provider call and local finalization are always distinguishable.

## Envelope state machine

```text
preparing ──▶ sent ──▶ delivered ──▶ completed   (terminal)
    │           │           └──────▶ declined    (terminal)
    │           └──────────────────▶ voided      (terminal)
    └──▶ failed ──(reconcile only)──▶ sent | delivered | completed | declined | voided
```

Transitions are **monotonic and server-authoritative**: a transition applies
only if its target ranks strictly higher, and `completed`/`declined`/`voided`
are terminal. A duplicate, late or contradictory event is stored in the inbox
and ignored — it can never regress a completed envelope, and no action turns a
completed envelope back into failed or declined.

`failed` means the **local** side failed while the provider may or may not hold
an envelope. The single documented policy is: **never silently retry, always
reconcile.** Four failure kinds stay distinguishable on the record
(`failurePhase` + `failureCode`): a provider request that failed, a local
finalization that failed after a possible provider success, event verification
that failed (never recorded against an envelope at all), and artifact/
reconciliation failure.

**Exactly one envelope per Quote Version, ever** — the DB-unique source key
`env:quote-version:<id>` is also the deterministic provider idempotency key. A
repeated request is `409 ENVELOPE_EXISTS`; a second provider envelope is
structurally impossible.

## Signer semantics (v1, narrow and stated)

All signers are required; 1–5 signers; the declared `order` is **recorded and
displayed, not sequentially gated**; no conditional routing, reminders or
delegation. **Signer identity assurance is not claimed** — only the provider's
own evidence is recorded.

## The document package

A deterministic canonical JSON package is derived from the approved Quote
Version: quote and version identity, parties, offer/product-version snapshot,
every component with its tier schedule and band breakdown, grouped totals, the
discount-policy decision, and the signer list. It is hashed with the canonical
SHA-256 helper; the hash is stored on the envelope, sent to the provider, and
**re-checked before an Order is created** — a snapshot that moved is a refusal
(`409 DOCUMENT_HASH_MISMATCH`), never a mis-signed order.

Its media type is `application/vnd.agent-crm.quote-package+json`. **It is not a
PDF and is never called one.**

## Event ingestion

```text
POST /api/signature/providers/:provider/events
```

- The **raw body** is preserved (re-serialized JSON would not reproduce what
  the provider signed) and bounded to 64 KiB.
- The provider is selected canonically from the path; only the bounded
  signature headers are passed to provider code.
- Verification runs **before any state mutation**. The shipped fixture uses
  constant-time HMAC-SHA256 over `timestamp.rawBody` plus a ±300 s replay
  window. A failure is a stable `401 SIGNATURE_INVALID` that never echoes the
  payload, the signature or the key.
- Accepted events land in an append-only inbox with a **DB-unique provider
  event id**: a replay is idempotent and answers identically.
- An event for an unknown envelope is **quarantined as evidence**, not
  discarded and not an error.
- Each event records its `effect`: `applied`, `ignored` (out of order or
  terminal) or `quarantined`.

**The fixture verification key is test-only, in checked-in source, and is not
production webhook security.** Real secret management — rotation, per-tenant
keys, a secret store — is Production Spine work.

## Completion is one atomic commitment

A verified `completed` transition performs, in **one** transaction: the
envelope transition, signer completion evidence, the `signed-artifact` record,
the `order` plus its lines, components, tiers and grouped totals, the managed
links on quote and envelope, and the audits/events. Any failure rolls all of it
back and leaves the inbox row unprocessed so reconciliation can complete it
later. Artifact metadata that needs a provider call is fetched in the
`external` phase, before the transaction opens.

`order:quote-version:<id>` is DB-unique, so duplicate webhooks, concurrent
webhooks and a webhook racing a reconcile can only ever produce **one Order**.

## Records (all read-only publicly)

`signature-envelope`, `signature-signer`, `signature-event`, `signed-artifact`,
`order`, `order-line`, `order-component`, `order-tier`, `order-total` —
capabilities `get`/`list` only. No public create or update exists on any of
them: records are produced solely by the signature operations through the
trusted in-process `createManaged`/`applyManaged` path, so no client can forge
an envelope status, a signature, an artifact hash or an order amount.

## What an Order snapshots

Everything, copied from the Quote Version — **never re-read from the live
catalog**: quote and version identity, envelope and artifact links, parties,
currency, per line the offer revision, product version, quantity and discount,
per component the charge type, pricing model, recurrence, amounts, complete
tier schedule and calculated band breakdown, and one grouped total per
`(currency, interval, intervalCount)`. Proven: a catalog tier and price change
after signing leaves both the Quote Version and the Order byte-identical.

An Order carries no fulfillment, billing, payment or invoice state, no ARR/MRR/
TCV (contract term is not modeled), and no amendment or cancellation path.

## Signed artifact evidence

Envelope link, provider artifact id, the canonical document hash, the provider
artifact hash where available, MIME type, size, storage reference, the
completion event id, completion timestamp and signer evidence. **The artifact
bytes are not stored in the database**, and long-term object-storage durability
is not claimed.

## Reconciliation

`app.reconcileSignature({envelopeId})` — or `POST
/api/signature/envelopes/:id/reconcile` — queries the provider outside every
transaction, by provider envelope id when known and otherwise by the
deterministic idempotency key. That key lookup is exactly how a provider
success whose local finalization failed is recovered. It applies the same
monotonic transition and the same atomic completion, never duplicates events,
artifacts or orders, and is honest when the provider holds nothing
(`absent-at-provider`). **No background scheduler ships**: recovery is always
an explicit, audited operation, called by the starter, the tests or a human.

## Human boundary

Only `actor.type === 'user'` may request a signature; an agent actor is refused
`403 HUMAN_APPROVAL_REQUIRED`. An agent may prepare the quote, the version and
the signer inputs — a human sends. This is a **human-actor boundary, not Sales
or Legal role enforcement**: real roles require the Production Spine
(authentication, tenancy, RBAC — `docs/strategy/EXECUTION_ROADMAP.md` Phase 6).

## Evidence

`tests/signature-contract.test.js`, `tests/signature-order-e2e.test.js`,
`tests/admin-signature.test.js`,
`examples/starters/b2b-lead-qualification/install.mjs`,
`docs/plans/milestone-11-signature-order.md`. Agent instructions:
`.claude/skills/build-signature-order/SKILL.md` (this file is the
Codex-readable mirror).
