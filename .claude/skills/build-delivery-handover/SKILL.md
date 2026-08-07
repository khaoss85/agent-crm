---
name: build-delivery-handover
description: Add or extend delivery handover and delivery execution in an Agent CRM project - turning the pending delivery obligations of an activated contract into a planned delivery project with work packages, milestones and an optional third-party partner engagement through a versioned handover policy, and running that project through bounded human-driven state transitions. Use for delivery project/commessa, work package, delivery milestone, partner engagement, handover, or starting/blocking/resuming/completing delivery work. Do not use for delivery economics, time, cost, change requests, deliverables or customer acceptance (none of which exist), contract activation (build-contract-activation), signature/order work (build-signature-order) or a single custom object (create-crm-module).
---

Read `ARCHITECTURE.md`, `DECISIONS.md` (ADR-018 and its addenda, and ADR-019 with addendum 1), `docs/DELIVERY_HANDOVER.md`, `docs/MODULE_EVOLUTION.md` and `docs/PACKAGE_AUTHORING.md` first.

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

## Do not implement here

Time and expense, cost, margin, economics snapshots, resource scheduling, capacity, change requests, deliverables, customer acceptance, billing milestones, invoicing, partner access or portal, revenue share, service contracts, entitlements, SLA, support cases, reopening completed work, a scheduler, a durable outbox, auth/tenancy/RBAC.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
