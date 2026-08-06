---
name: build-delivery-handover
description: Add or extend delivery handover in an Agent CRM project - turning the pending delivery obligations of an activated contract into a planned delivery project with work packages, milestones and an optional third-party partner engagement, through a versioned delivery handover policy. Use for delivery project/commessa, work package, delivery milestone, partner engagement or handover work. Do not use for contract activation (build-contract-activation), signature/order work (build-signature-order) or a single custom object (create-crm-module).
---

Read `ARCHITECTURE.md`, `DECISIONS.md` (ADR-018 and its addenda), `docs/DELIVERY_HANDOVER.md` and `docs/PACKAGE_AUTHORING.md` first.

## It plans; it does not deliver

1. Milestone 13 records a handover: a Delivery Project (`pending_kickoff`), one Work Package per delivery obligation, a milestone plan and an optional partner engagement. Nothing starts, progresses, completes, schedules, staffs, costs or bills — and no text may imply otherwise.
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

## Do not implement here

Delivery execution, progress or status transitions, time and expense, cost, margin, resource scheduling, capacity, change requests, customer acceptance, billing milestones, invoicing, partner access or portal, revenue share, service contracts, entitlements, SLA, support cases, a scheduler, a durable outbox, auth/tenancy/RBAC.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
