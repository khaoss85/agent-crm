---
name: build-contract-activation
description: Add or extend contract activation in an Agent CRM project - turning a signed immutable Order into a Commercial Contract, Contract Version and Lines, a Subscription with its lines, and pending delivery/service obligations, through a versioned Order Activation Policy. Use for contract, subscription, obligation or activation-policy work, and for building a new optional domain package. Do not use for signature/order work (build-signature-order), catalog/quote/discount work (build-commercial-operations) or CRUD module changes (create-crm-module).
---

Read `ARCHITECTURE.md`, `DECISIONS.md` (ADR-018 and its Milestone 12 addendum) and `docs/CONTRACT_ACTIVATION.md` first.

## Build it as a domain package, not in core

1. A new domain lives in `packages/<domain>/` and is registered through the checked-in `packages/domains/generated/index.js` — the same path a third-party package uses. The kernel must never import it, and removing that one static import must leave every other milestone working. Prove it: boot the same project without the package and assert the kernel is unchanged.
2. The domain declaration is plain data: `{ name, domainContract: 1, label, actions[], policies[{kind, definition}], metadata() }`. `metadata()` returns function-free JSON for `/api/schema`; never a handler, a credential or a path.
3. If the domain needs something the runtime does not have, that is a **generic** runtime capability with no domain word in it, recorded as an ADR-018 addendum — never a domain concept smuggled into `packages/core`. M12 needed exactly two: the domain registry seam and a strict `boolean` input type.
4. Domain records are ordinary manifests (`writable: "managed"` throughout → capabilities `get`/`list`) applied by the project, not written by hand.

## Classify explicitly, never from recurrence

1. **Recurrence is not a classification.** Annual support recurs and is a service obligation; a recurring API charge may create no obligation at all; a one-time migration is delivery work. Deciding from `chargeType` silently mis-files real money.
2. Classification is a **versioned, fingerprinted policy** (ADR-015): `defineOrderActivationPolicy({name, version, config, classifyComponent})`. Deterministic, synchronous, total — no clock, no network, no database, no randomness. Thresholds and mappings go in `config` so the fingerprint covers them; a closure-held table is invisible to it.
3. Decide from **explicit identity in the Order snapshot** — component key, SKU, offer — never from label text and never from the live catalog. The context is deep-frozen on purpose.
4. Anything the policy cannot place is `ambiguous`, and `ambiguous` **blocks activation**. It is not the same as `other`, which is a recorded decision that nothing further is owed. Do not add a default that guesses.
5. Publish a new version to change a decision; never edit a registered one (the next boot refuses it). Historical activations must still explain themselves.
6. Enforce coherence regardless of policy or override: a subscription line must recur (`409 CLASSIFICATION_INCOHERENT`).

## Separate planning from committing

1. `plan-activation` is read-only: no domain record, no business audit, no event. Any actor may prepare it — that is how an agent contributes without committing the business.
2. `activate-contract` requires `actor.type === 'user'` (an agent is `403 HUMAN_APPROVAL_REQUIRED`). It is a human-actor boundary, **not** Finance/Legal role enforcement — real roles need the Production Spine.
3. Recompute the plan **inside** the activation transaction from the Order. Never trust a plan, an amount, a product, a tier or a hash supplied by the client.
4. A human override is a decision on the record: bounded non-blank reason, never `ambiguous`, never a component of another order, no control characters (SQLite ends a text value at the first NUL byte). Store both the policy's classification and the override.

## Copy the signed source, prove it first

1. The signed immutable Order is the only commercial source. Verify before writing: order `accepted`, envelope `completed` and belonging to the same quote version, artifact belonging to that envelope, the three agreeing on the document hash, and the snapshot complete. Each refusal gets a stable code.
2. Copy every amount, tier schedule and grouped total; reading the live catalog here is a defect. Copy the customer from the Order's own party snapshot so a rename cannot move the contract.
3. Dates are calendar dates (`YYYY-MM-DD`), validated by round-trip so `2026-02-30` is refused rather than normalized. State inclusivity, bound the term, and record auto-renew and notice days as **recorded only** — there is no scheduler, so nothing fires on them.

## One transaction, DB-enforced identity

1. Activation run, contract, version, lines, subscription, subscription lines and obligations commit together or not at all. Test it with fault injection at every write, and prove the retry produces exactly one complete activation.
2. Identity is a DB-unique source key, not a check-then-write: `contract:order:<orderId>`, `contract-version:<contractId>:1`, `subscription:contract:<contractId>`, `contract-line:<versionId>:<componentId>`. Prove it with two concurrent activations in one app and across two connections.
3. Never modify the source Order: set only its managed link.
4. "Already activated" is the first answer on a retry — before any classification work — so the refusal does not depend on whether the caller repeated the overrides.

## Admin

Plan control, every classification with its reason, ambiguity highlighted with an override editor that demands a reason, calendar term inputs, one activation control that disables on submit, the human-actor caveat stated. After activation: evidence only — no control to progress, complete, bill, renew or cancel anything. The section renders only when `/api/schema` publishes the domain.

## Do not implement here

Billing, invoicing, payment, usage rating, proration, ramps, minimum commitments, tax, FX, revenue recognition, MRR/ARR/TCV, amendments, seat changes, renewal, cancellation, delivery execution, partner assignment, time/expense/margin, change requests, customer acceptance, service contracts, entitlements, SLA, support cases, a scheduler, a durable outbox, auth/tenancy/RBAC.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
