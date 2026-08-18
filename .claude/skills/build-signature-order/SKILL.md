---
name: build-signature-order
description: Add or extend Signature and Order in an Accordo project - signature providers, envelope/signer/event state, verified webhooks, signed-artifact evidence, reconciliation and immutable Orders built from an approved Quote Version. Use for signature, envelope, webhook or order work. Do not use for catalog/quote/discount work (build-commercial-operations) or CRUD module changes (create-crm-module).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/domains/generated/index.js"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/SIGNATURE_ORDER.md"]
  degradesTo: "the composed signature providers, actions and records reported by `crm app inspect --json`"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

`providers[]` reports declared metadata and the **keys** of a declared config, never a value. It is never evidence that a signature provider is credentialed, reachable or legally qualified — `PROVIDER_HEALTH_UNKNOWN` and `SECRETS_NOT_INSPECTED` are in `limitations[]` for exactly that reason.

**Background, where they exist:** `ARCHITECTURE.md`, `DECISIONS.md` (ADR-016 and ADR-017) and `docs/SIGNATURE_ORDER.md`. They are the deeper source for the rules below, not a prerequisite for them — the rules stand on their own.

## Sequence an external side effect

1. Never call a provider inside a database transaction, and never claim atomicity between the local database and a remote service. Declare the bounded external-operation shape instead: `externalOperation: 1` with `intent` (transaction A), `external` (no transaction, bounded timeout), `finalize` (transaction B) and `compensate` (its own transaction, only on failure).
2. The `external` phase gets frozen JSON-safe data plus the provider registry — **no database, no modules, no managed writes**. If you find yourself wanting a service handle there, the work belongs in `intent` or `finalize`.
3. Give every external call a **deterministic idempotency key** derived from the record it belongs to (here: `env:quote-version:<id>`, which is also the DB-unique source key). A repeated request must be refused, not retried into a second remote object.
4. On failure, move to a **recoverable** local state and record the phase and code. The single policy is: never silently retry, always reconcile.
5. A provider answer that is already terminal is a **completion**, not a status: route every provider state through the one path that creates the artifact and the order, and prefetch what that needs in `external`. Persisting a terminal state without its evidence is unrecoverable.
6. An idempotency key is a **lookup, not an identity**: before adopting a provider envelope, check the document hash, the signer set and any known provider envelope id, and fail closed on a mismatch.
7. Do not build a scheduler, an outbox or a workflow DSL.

## Add a signature provider

1. Define it code-first: `{ name, version, label, config, createEnvelope, getEnvelope, verifyEvent, getSignedArtifact }` and register it in the composition: pass it to `createSignatureDomain({ signatureProviders: [...] })` in `packages/domains/generated/index.js` (static import — the composition file is the only place a project names its packages).
2. The declared-definition fingerprint proves **provider code and config integrity, not remote-service behavior**. Re-validate every provider result into the normalized contract (`normalizeProviderEnvelope`/`normalizeProviderEvent`/`normalizeProviderArtifact`) before it touches local state; off-contract data is `PROVIDER_INVALID`. A provider may never assert the local-only `preparing`/`failed` states.
3. `verifyEvent` receives the **raw bytes** (a Buffer — decoding first would replace invalid UTF-8 and verify something the provider never signed), must compare in constant time and must bound replay by timestamp. Never log or echo the payload, the signature or the key.
4. A verification key in checked-in `config` is **test-only**. Do not describe it as production webhook security, and do not ship a real DocuSign/Adobe/Dropbox adapter or credential.

## Extend the envelope state machine

1. Transitions are monotonic: apply only when the target ranks strictly higher. `completed`, `declined` and `voided` are terminal — no event and no action may regress them.
2. Every accepted event is an append-only inbox row keyed by a DB-unique provider event id **plus a fingerprint of the verified bytes**. The same id with the same bytes is a stable duplicate; the same id with different bytes is a conflict, never an acknowledged replay. A row whose processing failed stays unprocessed and must be **resumed** on redelivery. An unknown envelope is quarantined evidence that gets linked once the provider id is known — never a silent discard.
3. Signer semantics in v1: all signers required, 1–5 signers, declared order recorded but not sequentially gated, no conditional routing. Never claim signer identity assurance beyond provider evidence.

## Create an Order

1. One Order per completed signed Quote Version, keyed `order:quote-version:<id>` (DB-unique) — the guarantee that duplicate, concurrent or reconciled completions cannot produce two.
2. **Copy, never recalculate.** Lines, components, tier schedules, band breakdowns and grouped totals come from the Quote Version snapshot; reading the live catalog here is a defect.
3. Rebuild the document package from **immutable snapshot rows plus the party snapshot taken at request time** — never from live CRM records, or a rename would block completion forever — and refuse (`DOCUMENT_HASH_MISMATCH`) if it no longer hashes to what was signed. Canonicalize with one deterministic serializer; `localeCompare` in a hashed path is a defect.
4. The completion transition, artifact and full order snapshot commit in ONE transaction, or none of it does.
5. Do not add fulfillment, billing, payment, invoice, tax, FX, amendment or cancellation state.

## Storage and surface

Every signature/order module is **read-only publicly** (all fields `writable: "managed"` → capabilities `get`/`list`); records exist only through the trusted `createManaged`/`applyManaged` path. Provider events get a dedicated raw-body route, never a record action. Schema metadata stays function-free and never exposes a verification key, a raw payload or a storage path.

## Human boundary

Only `actor.type === 'user'` may request a signature (agents get `403 HUMAN_APPROVAL_REQUIRED`). It is a human-actor boundary, **not** Sales/Legal role enforcement — real roles need the Production Spine.

## Do not implement here

Real signature credentials or APIs, production PDF generation, legal signature qualification, payments, billing, invoicing, tax, FX, revenue recognition, fulfillment, Delivery/Service, cancellation, refunds, order amendments, renewals, a background scheduler, a durable distributed outbox, a generic workflow or document DSL, auth/tenancy/RBAC.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
