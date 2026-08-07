---
name: build-delivery-handover
description: Add or extend delivery handover, delivery execution, delivery economics and delivery change, deliverables and acceptance evidence in an Accordo project - turning the pending delivery obligations of an activated contract into a planned delivery project with work packages, milestones and an optional third-party partner engagement through a versioned handover policy, running that project through bounded human-driven state transitions, and recording governed change requests, plan revisions, deliverables and customer acceptance evidence. Use for delivery project/commessa, work package, delivery milestone, partner engagement, handover, starting/blocking/resuming/completing delivery work, change requests, deliverables or recorded customer acceptance. Do not use for contract amendment, invoicing or billing (none of which exist), contract activation (build-contract-activation), signature/order work (build-signature-order) or a single custom object (create-crm-module).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/domains/generated/index.js", "packages/contracts/", "packages/core/index.js"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/DELIVERY_HANDOVER.md", "docs/DELIVERY_ECONOMICS.md", "docs/DELIVERY_CHANGE_ACCEPTANCE.md", "docs/MODULE_EVOLUTION.md", "docs/PACKAGE_AUTHORING.md"]
  degradesTo: "the capability graph in `crm app inspect --json` — which reports whether `contracts/delivery-obligations@1` resolves for this project — plus `crm package validate`"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

This skill depends on one capability, so check it in the report before anything else: `capabilities[]` must carry `delivery-obligations` with `status: "resolved"`. A `missing` or `provider-mismatch` edge is the answer to why nothing here will work, and it is reported rather than worked around.

**Background, where they exist:** `ARCHITECTURE.md`, `DECISIONS.md` (ADR-018 and its addenda, and ADR-019 with addendum 1), `docs/DELIVERY_HANDOVER.md`, `docs/DELIVERY_ECONOMICS.md`, `docs/DELIVERY_CHANGE_ACCEPTANCE.md`, `docs/MODULE_EVOLUTION.md` and `docs/PACKAGE_AUTHORING.md`. They are the deeper source for the rules below, not a prerequisite for them — the rules stand on their own.

## It plans and runs; it does not cost, bill or accept

1. Milestone 13 records a handover: a Delivery Project (`pending_kickoff`), one Work Package per delivery obligation, a milestone plan and an optional partner engagement. Milestone 14a runs it. Nothing schedules, staffs, costs, bills or accepts — and no text may imply otherwise.
2. A planned milestone is not a contractual or billing milestone. Say so wherever one is shown.
3. Target dates are **post-sale planning data** (`datesSource: "post-sale-delivery-planning"`), not signed terms and not a customer commitment. Nothing fires on them; there is no scheduler.

## Reach the sale only through the capability

1. Delivery depends on `contracts/delivery-obligations@1` and on nothing else in that package: no service import, no table, no source key. If the capability lacks something, add it **inside `packages/contracts`**, never in the kernel.
2. Open it with your own `modules`, `actor` and `now`, so the obligation update commits inside your transaction. An unawaited managed write would escape it — await every one.
3. Mark exactly the obligations you planned, by id, and let the capability refuse a foreign or already-handed-over id. Service obligations are not Delivery's business: never touch them.

## Decide who delivers, never guess

1. `deliveryMode` is `internal | partner | ambiguous`, decided by a versioned, fingerprinted policy from identity the obligation already carries — component key, SKU, product, provider. Label text decides nothing.
2. `ambiguous` blocks the handover until a human chooses with a bounded, non-blank, control-character-free reason. Store the policy's answer next to the human's.
3. Bound everything the policy returns: work-package label, milestone keys (canonical, de-duplicated, capped), reason. A Promise, an unknown mode or an unbounded label is a policy defect and fails closed.

## Partner semantics

1. One optional partner per project in v1. A partner is a **business reference and a name snapshot** — never an account, login, portal, invitation, permission, fee, revenue share or SLA. Never describe it as access.
2. A partner is required exactly when some work package is partner-delivered, and refused when none is. Multiple partners are deferred: fail explicitly rather than inventing an unreviewed array model.

## Plan versus create

1. `plan-delivery-handover` is read-only: no delivery record, no business audit, no event. Any actor may prepare it.
2. `create-delivery-handover` requires `actor.type === 'user'` (an agent is `403 HUMAN_APPROVAL_REQUIRED`) — a human-actor boundary, not Delivery Manager RBAC.
3. Recompute the plan inside the transaction. A plan the caller computed earlier authorizes nothing.
4. "Already handed over" is the first answer on a retry, before any policy work.

## One transaction, DB-enforced identity

1. Handover run, project, work packages, milestones, partner engagement and the obligation updates commit together or not at all. Inject failure after every write — including the cross-package one — and prove the retry produces exactly one complete handover.
2. Identity is a DB-unique source key: `delivery-project:contract:<contractId>`, `delivery-work-package:<projectId>:<obligationId>`, `delivery-milestone:<projectId>:<key>`. Prove it with two concurrent handovers in one app and across two connections.
3. Every delivery record carries its own snapshot (customer, label, amount, currency) so it reads without the contract, the catalog or a live CRM row.

## Execution: a state is a claim, so make it reachable

1. The allowed moves are an **explicit table as data**, never a rank comparison. `completed > in_progress` is arithmetic; a table is a business rule you can read in a diff.
2. **Never declare a state nothing can reach.** An enum value with no action behind it is a capability claim without a capability, and the same goes for a table edge no action walks. Derive both checks from the shipped action list in a test — do not assert them in a comment.
3. Two actions may share a target state (starting a work package and resuming a blocked one both end `in_progress`). The table cannot tell them apart, so each action declares the states **it** applies to, and the package publishes that map so a client can offer only what a record can take.
4. Every transition requires `actor.type === 'user'`. That is a human-actor boundary, not Delivery Manager RBAC — say so on the wire, not only in a doc.
5. Accept an optional `expectedState` and refuse a mismatch with a stable `409`. A human decision must never silently overwrite another one.
6. Respect the hierarchy in both directions: work moves only under a running project, and a project closes only over completed work packages and milestones — counted with exact indexed reads, never a paged list. A blocked work package holds its project open; that is the honest answer.
7. A block states a **required** reason and records who and when. Clearing those fields on resume keeps the record truthful; the history of blocks belongs in the audit log.
8. Bound every free-text field yourself. `optionalString`/`requiredString` take no options, so an options object handed to them is silently ignored and the field is unbounded. Reject the C0 controls except tab, newline and carriage return, plus DEL, U+2028 and U+2029 — and write that character class with **escapes**, or the file becomes a binary blob to git and grep.
9. Nothing transitions on a clock. There is no scheduler in this framework.

## Growing a record that already shipped

1. Adding a state to a shipped record is a **module evolution**: bump `revision` in the manifest and apply it. A module generated before ADR-019 has no `module.state.json` and is adopted automatically on the first evolution.
2. The upgrade path is not theoretical — prove it. Build a project with the previous milestone's own CLI, upgrade the framework in place, apply the new manifests, and check the original create-migration checksums are unchanged.

## Economics: evidence, not accounting

1. Time and expense are **evidence**. Every record is `writable: "managed"` — no public create, update or delete anywhere — because a snapshot computed on Tuesday must still be reproducible on Wednesday. A correction is a new entry.
2. **The server computes money.** A caller supplies minutes; the versioned cost policy supplies the rate; the action multiplies and rounds. A client-supplied cost, rate or currency is not authoritative and must not even be an input.
3. State the rounding rule and publish it: `roundHalfUp(ratePerHourCents × minutes / 60)`, integers throughout, the product checked before the division. Test 1, 30, 60 and 61 minutes, an exact half-cent tie, zero, and the safe-integer boundary.
4. **Group by currency, never sum across them.** There is no FX here, so there is no grand total. A policy returning a rate in another currency than the work is a refusal, not a conversion.
5. The commercial input comes **only** from the immutable work-package snapshot. Never a live catalog, a quote draft or a client number. An obligation with no deterministic amount is unavailable evidence, not an invented one.
6. Use the honest word: **delivery contribution estimate**. Never gross margin, accounting margin, recognized revenue or profit.
7. An idempotency key is not an edit handle. A retry whose values differ from what that key stored is a `409` conflict naming the divergent fields — never a silent `created: false` over the old values.
8. Whatever the caller names — policy, version, or both — must exist. Never substitute another rate card and store it as evidence.
9. A contribution estimate exists only where every commercial input in that currency is **one-time**. If the project carries a recurring obligation, `contributionBasis` is `unavailable` and the estimate is `null` — report it as unavailable and say why. Never annualize, normalize or sum across periods to manufacture one.
10. Rates live in the policy's `config`, so they are inside the declared-definition fingerprint — a rate is versioned as strictly as the code. A rate table is not payroll and identifies nobody.
11. Recording, publishing and snapshotting require `actor.type === 'user'`. An agent may preview and nothing else, and a preview must say `stored: false`.
12. Consumption is recorded only while work is happening: the project `in_progress`, the work package `in_progress` or `blocked`. A blocked package still consumes time; a completed one does not.

## Change, deliverables and acceptance: evidence, not authority

1. A change request is **decided once** by a `user` actor, from `proposed`. Approving a non-commercial replan writes an immutable, versioned Plan Revision; it never rewrites the M13 handover snapshot, the signed Order or completed execution.
2. A change with commercial consequence raises an immutable `delivery-commercial-change` candidate and **stops**. Never create or alter a Quote, Order, Contract, Contract Version or Subscription here, never recognize an amount, never emit an amendment event.
3. That candidate must have an end. It blocks acceptance over the scope it touches, and the change request's `pending_commercial_followup` is terminal — so `resolve-commercial-change` records what the follow-up concluded **elsewhere** (`resolved_externally` or `withdrawn`). Recording it amends nothing. Any gate you add on a terminal state needs the same treatment: a refusal with no exit is a trap, not a guarantee.
4. A deliverable completes only from a work package the **server** says is completed, and the result says `accepted: false`. Completed work is not customer acceptance; say so wherever one is shown.
5. An acceptance request **freezes** its scope and stores it. Never rebuild that scope from the current deliverable set — old testimony would silently re-point at new work. Fingerprint the body of work only: never fold an unverified operator label such as `customerRef` into a fingerprint a correctness rule depends on.
6. Acceptance evidence is what a **user actor recorded a customer as saying**. Not an authenticated customer action, not a legal signature, not a verified identity, not authorization to bill. Every screen and every capability description must say so.

## Do not implement here

Invoicing, payment, tax, FX, accounting, revenue recognition, gross or accounting margin, profit, payroll, employee identity, resource scheduling, capacity, partner payout, billing eligibility, receipt or document storage, reimbursement, partner access or portal, revenue share, service contracts, entitlements, SLA, support cases, reopening completed work, a scheduler, a durable outbox, auth/tenancy/RBAC — and contract amendment, legal acceptance, authenticated customer identity, a customer portal and any external send or notification, none of which exist.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
