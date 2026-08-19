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

The **allowed-transition table is the contract** — not a rank comparison.
`completed`, `declined` and `voided` are branching outcomes, not points on a
scale, so a rank would make `completed → declined` and `declined → completed`
look equal. The table is published in `/api/schema` as
`signature.allowedTransitions`:

| From | May become |
|---|---|
| `preparing` | `failed`, `sent`, `delivered`, `completed`, `declined`, `voided` |
| `failed` | `sent`, `delivered`, `completed`, `declined`, `voided` |
| `sent` | `delivered`, `completed`, `declined`, `voided` |
| `delivered` | `completed`, `declined`, `voided` |
| `completed` / `declined` / `voided` | *(nothing — terminal)* |

A duplicate, late or contradictory event is stored in the inbox and ignored —
it can never regress a completed envelope, and no action turns a completed
envelope back into failed or declined. `preparing` and `failed` are
**local-only**: a provider may never assert them.

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

An idempotency key is a **lookup, not an identity**. Before a provider envelope
is adopted — at creation and at reconciliation — it must agree with the local
intent on the document hash and the signer set, and on the provider envelope id
when one is already known; a disagreement is `409 PROVIDER_ENVELOPE_MISMATCH`
and nothing is bound. A provider that echoes neither field cannot be checked on
it, and that weaker guarantee is stated rather than assumed away.

**Retained M11 limitation:** a quote version whose envelope failed — including
one the provider never received (`PROVIDER_ENVELOPE_ABSENT`, which is recorded
distinctly from an unknown outcome) — **cannot be sent again**. Reconciliation
is the only recovery path; there is no resend framework, and the Admin says
which of the three cases applies instead of implying the provider's state is
known when it is not.

## Signer semantics (v1, narrow and stated)

All signers are required; 1–5 signers; the declared `order` is **recorded and
displayed, not sequentially gated**; no conditional routing, reminders or
delegation. **Signer identity assurance is not claimed** — only the provider's
own evidence is recorded.

## The document package

A deterministic canonical JSON package is derived from the approved Quote
Version: quote and version identity, parties, offer/product-version snapshot,
every component with its tier schedule and band breakdown, grouped totals, the
discount-policy decision, and the signer list — plus a `terms` section **only
when the version froze a commercial-term snapshot** (`quote-version-term`).
A termless version produces the exact pre-terms document, byte for byte: the
optional key extends the hash algebra without reshaping it, and
`documentContract` stays `1`. When present, the term is covered by the hash,
and verified completion copies it onto the Order as the write-once
`order-term` row — so what was signed and what the Order records can never
silently diverge, and an order signed without a term is never backfilled.

**The hash covers the exact bytes that are sent.** `canonicalJson` emits one
deterministic serialization — object keys sorted by code unit, array order
preserved, no whitespace, and no locale-sensitive comparison anywhere — the
SHA-256 is taken over exactly those bytes, and exactly those bytes are what the
provider receives. CRLF vs LF, precomposed vs decomposed Unicode and `1` vs
`"1"` are different documents; no normalization is silently applied.

The commercial **parties are snapshotted once, at request time**, and stored on
the envelope. The package is rebuilt only from immutable snapshot rows plus
that snapshot, so a customer rename can never make the signed document
unreproducible. The rebuild is re-checked before an Order is created — a
snapshot that really moved is `409 DOCUMENT_HASH_MISMATCH`, never a mis-signed
order — and the stored canonical bytes are re-hashed too, so both the snapshot
rows and the stored evidence are proven.

Its media type is `application/vnd.accordo.quote-package+json`. **It is not a
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
  event id** plus a **fingerprint of the verified bytes**. Replay scope is
  therefore `provider + providerEventId + payload`: the same id with the same
  bytes is a stable duplicate, and the same id with **different** bytes is
  `409 EVENT_ID_CONFLICT` rather than an acknowledged replay.
- An inbox row whose *processing* failed stays `processed: false`, and a
  redelivery **resumes** it. A failed completion is retryable, never stranded
  behind its own duplicate check.
- An event for an unknown envelope is **quarantined as evidence**, not
  discarded and not an error. Once the envelope learns its provider id, the
  matching quarantined rows are linked to it and reconciliation produces the
  artifact and the Order that event announced — an early completion is never
  silently lost.
- The raw body travels as bytes from the socket to verification: decoding it
  to a string first would replace invalid UTF-8 and verify something the
  provider never signed. The ±300 s window is inclusive at the boundary.
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

Envelope link, provider artifact id, the canonical document hash, the signed
canonical document itself, the provider artifact hash where available, MIME
type, size, storage reference, the completion event id, completion timestamp
and signer evidence.

`artifactHash` is **provider-reported**: accordo does not download or hash
the artifact bytes and **verifies no signature cryptographically**. The
artifact bytes are not stored in the database, and long-term object-storage
durability is not claimed. What *is* locally verifiable is the document
package: the stored canonical bytes re-hash to `documentHash` at completion.

## Crash and recovery matrix

| Where the process dies | Local state after restart | Safe next step |
|---|---|---|
| before the intent commits | nothing exists | request again |
| after intent, before the provider call | envelope `preparing`, no provider id | **reconcile** (absent → `failed` + `PROVIDER_ENVELOPE_ABSENT`) |
| during the provider call | envelope `preparing` | **reconcile** — the provider may hold it |
| provider accepted, process dies before the result is observed | envelope `preparing` | **reconcile** recovers it by idempotency key |
| result observed, finalize rolls back | envelope `preparing`/`failed` | **reconcile** |
| finalize commits, the response is lost | envelope `sent`/terminal, order created if terminal | re-read; reconcile is a safe no-op |
| compensation itself fails | envelope stays non-terminal | **reconcile** |
| any point after a terminal state | terminal, order present | reconcile short-circuits (`terminal`) |

In every row: requesting again is refused (`ENVELOPE_EXISTS`), reconciliation
is idempotent, and **no second provider envelope can be created for one Quote
Version** — proven with a real killed child process and with two app instances
on one database.

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
