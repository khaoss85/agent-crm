---
name: build-contract-activation
description: Add or extend contract activation and renewal/amendment execution in an Accordo project - turning a signed immutable Order into a Commercial Contract, Contract Version and Lines, a Subscription with its lines and pending delivery/service obligations through a versioned Order Activation Policy, and executing a governed SUCCESSOR agreement from a later signed Order with immutable lineage. Use for contract, subscription, obligation, activation-policy, renewal, amendment, successor or contract-lineage work, and for building a new optional domain package. Do not use for signature/order work (build-signature-order), catalog/quote/discount work (build-commercial-operations), billing or cancellation (neither exists) or CRUD module changes (create-crm-module).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/domains/generated/index.js", "packages/core/index.js"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/CONTRACT_ACTIVATION.md", "docs/RENEWAL_AMENDMENT.md", "docs/PACKAGE_AUTHORING.md"]
  degradesTo: "the composed packages, capabilities and policies reported by `crm app inspect --json`, plus `crm package validate` for the contract a package must satisfy"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

**Background, where they exist:** `ARCHITECTURE.md`, `DECISIONS.md` (ADR-018 and its addenda), `docs/CONTRACT_ACTIVATION.md` and `docs/PACKAGE_AUTHORING.md`. They are the deeper source for the rules below, not a prerequisite for them — the rules stand on their own.

## Build it as a domain package, not in core

1. A new domain lives in `packages/<domain>/` and is registered through the checked-in `packages/domains/generated/index.js` — the same path a third-party package uses. The kernel must never import it, and removing that one static import must leave every other milestone working. Prove it: boot the same project without the package and assert the kernel is unchanged.
2. The declaration is plain data built with `definePackage` from the public surface `packages/core/index.js`: `{ packageContract: 1, name, version, label, resources[], requires[], capabilities[], actions[], policies[{kind, definition}], metadata() }`. `metadata()` returns function-free JSON for `/api/schema`; never a handler, a credential or a path. Import nothing else under `packages/core` — `docs/PACKAGE_AUTHORING.md` and `crm package validate` are the contract.
3. If the domain needs something the runtime does not have, that is a **generic** runtime capability with no domain word in it, recorded as an ADR-018 addendum — never a domain concept smuggled into `packages/core`. M12 needed exactly three: the domain registry seam, a strict `boolean` input type and an injectable application clock.
4. Domain records are ordinary manifests (`writable: "managed"` throughout → capabilities `get`/`list`) applied by the project, not written by hand.

## Classify on two axes, never from recurrence

1. **Recurrence is not a classification, and one axis is not enough.** Ask two questions per component: is it a recurring right (`commercialActivation`), and does it owe anything beyond the money (`obligations`)? Annual support answers *yes* to both — a single exclusive label has to drop one, and dropping the first removes real recurring money from the subscription. A recurring API charge may owe nothing; a one-time migration owes delivery work.
2. Classification is a **versioned, fingerprinted policy** (ADR-015): `defineOrderActivationPolicy({name, version, config, classifyComponent})`. Deterministic, synchronous, total — no clock, no network, no database, no randomness. Thresholds and mappings go in `config` so the fingerprint covers them; a closure-held table is invisible to it.
3. Decide from **explicit identity in the Order snapshot** — component key, SKU, offer — never from label text and never from the live catalog. The context is deep-frozen on purpose.
4. Either axis may be `ambiguous`, and an ambiguous axis **blocks activation** until a human resolves *that axis* with its own reason. `obligations: []` is a decision that nothing further is owed; `'ambiguous'` is the absence of one. Do not add a default that guesses.
5. Every component becomes exactly one Contract Line whatever the answers are, and no obligation type is ever created twice for one component.
6. Publish a new version to change a decision; never edit a registered one (the next boot refuses it). Historical activations must still explain themselves.
7. Enforce coherence regardless of policy or override: a subscription line must recur (`409 CLASSIFICATION_INCOHERENT`).

## Separate planning from committing

1. `plan-activation` is read-only: no domain record, no business audit, no event. Any actor may prepare it — that is how an agent contributes without committing the business.
2. `activate-contract` requires `actor.type === 'user'` (an agent is `403 HUMAN_APPROVAL_REQUIRED`). It is a human-actor boundary, **not** Finance/Legal role enforcement — real roles need the Production Spine.
3. Recompute the plan **inside** the activation transaction from the Order. Never trust a plan, an amount, a product, a tier or a hash supplied by the client.
4. A human override decides **one dimension of one component** (`{orderComponentId, dimension, value, reason}`): bounded non-blank reason, never the ambiguity it is meant to resolve, never a component of another order, never the same component and dimension twice, no control characters (SQLite ends a text value at the first NUL byte). Store the policy's answer and the human's on each axis.

## Copy the signed source, prove it first

1. The signed immutable Order is the only commercial source. Verify before writing: order `accepted`, envelope `completed` and belonging to the same quote version, artifact belonging to that envelope, the three agreeing on the document hash, and the snapshot complete. Each refusal gets a stable code.
2. Copy every amount, tier schedule and grouped total; reading the live catalog here is a defect. Copy the customer from the Order's own party snapshot so a rename cannot move the contract.
3. Dates are calendar dates (`YYYY-MM-DD`), validated by round-trip so `2026-02-30` is refused rather than normalized. State inclusivity, bound the term, refuse a notice period without auto-renewal, and record auto-renew and notice days as **recorded only** — there is no scheduler, so nothing fires on them.
4. **Do not present a post-signature input as a signed term.** If the signed document does not carry it, store its provenance next to it (`termsSource`) and require a human reason. When the order DOES carry a signed term snapshot (`order-term`), copy it verbatim as `signed-order-terms`, refuse manual term inputs (`SIGNED_TERMS_AUTHORITATIVE`) and collect no reason — the signature is the reason. Check what the document package actually contains before writing "the signed term" anywhere, and never collapse the two provenances.
5. **Nothing is active before it starts.** Decide state against an injected business date: a future term is `scheduled` and stays scheduled (no scheduler exists), and an ended term is refused rather than recorded as active.

## One transaction, DB-enforced identity

1. Activation run, contract, version, lines, subscription, subscription lines and obligations commit together or not at all. Test it with fault injection at every write, and prove the retry produces exactly one complete activation.
2. Identity is a DB-unique source key, not a check-then-write: `contract:order:<orderId>`, `contract-version:<contractId>:1`, `subscription:contract:<contractId>`, `contract-line:<versionId>:<componentId>`. Prove it with two concurrent activations in one app and across two connections.
3. Never modify the source Order: set only its managed link.
4. "Already activated" is the first answer on a retry — before any classification work — so the refusal does not depend on whether the caller repeated the overrides.

## Admin

Plan control, both axes of every classification with their reasons, each undecided axis highlighted with its own override editor that demands a reason, calendar term inputs carrying the term's provenance, one activation control that disables on submit, the human-actor caveat stated. After activation: evidence only — no control to progress, complete, bill, renew or cancel anything. The section renders only when `/api/schema` publishes the domain.

## Renewal and amendment execution (M16b, ADR-035)

A renewal or amendment does **not** edit the agreement. It produces a
**successor agreement** — its own signed Order, its own document hash, its own
term and its own Subscription — written by the *same* activation writer, plus
one immutable `contract-succession` row naming what it replaces. Issue no
`UPDATE` against any historical contract, version, line, subscription or
obligation row.

1. **Signed evidence or nothing.** Build a successor only from an Order carrying
   the ADR-033 term snapshot (`order-term`, covered by the signed
   `documentHash`). An Order whose signed document carried no term is refused
   `409 SUCCESSOR_TERMS_NOT_SIGNED`. Never promote post-signature operational
   dates into a signed renewal term, and never collapse the three provenances
   (signed / post-signature operational / absent-unknown) into one badge.
2. **Plan and execute are different things.** The plan writes nothing — no
   record, no audit entry, no domain event. Execution is human-only and
   recomputes every fact inside its own transaction, so a recorded `ready` is an
   observation with a timestamp and never an authorisation.
3. **One execution per source, enforced by the database.**
   `contract-succession.sourceContractId`, `.successorContractId`,
   `.successorOrderId` and `.executionRef` are each UNIQUE. No in-process lock.
4. **Derive the classification; never accept one.** Match lines on
   `offerLogicalKey|componentKey` and derive `renewal | expansion | contraction
   | mixed | commercial_change` from the delta. Claim a narrow label only when
   the evidence supports exactly one reading — a price movement with no quantity
   movement is `commercial_change`, because nothing about it expanded.
5. **Record continuity; block only incoherence.** `contiguous | gap | overlap |
   unknown` against the source's inclusive end date. Overlap is a mid-term
   amendment and a gap is a lapse; only a successor term starting before the
   source term started is refused.
6. **The round has an exit.** `planned → awaiting_signed_order | ready →
   executed`, plus `abandoned` from any non-terminal state; both terminals never
   regress and nothing in the table reads a clock.

## Do not implement here

Billing, invoicing, payment, usage rating, proration, ramps, minimum commitments, tax, FX, revenue recognition, MRR/ARR/TCV, seat changes on a live subscription, **automatic or scheduled renewal**, renewal-notice delivery, customer notification, cancellation, delivery execution, partner assignment, time/expense/margin, change requests, customer acceptance, service contracts, entitlements, SLA, support cases, a scheduler, a durable outbox, auth/tenancy/RBAC.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
