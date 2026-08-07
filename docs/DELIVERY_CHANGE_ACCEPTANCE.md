# Delivery change, deliverables and acceptance (Milestone 14b2)

M14b1 recorded what a delivery project **consumed**. M14b2 records what changed
about it, what it **produced**, and whether anyone said the work was done.

**None of it is commercial, and none of it is authentication.** No Quote, Order,
Contract or Subscription is created or altered; no amendment exists; no invoice,
payment or billing eligibility is produced; no customer is authenticated and no
legal signature is claimed.

## What ships

```text
delivery-change-request       proposed → approved | rejected | pending_commercial_followup
delivery-plan-revision        immutable, versioned: the replan an approval produced
delivery-commercial-change    immutable candidate for a future commercial amendment
delivery-deliverable          planned → completed, gated on execution state
delivery-acceptance-request   immutable: what was submitted, and when
delivery-acceptance-evidence  immutable: what a human recorded a customer as saying
```

Six actions, on the records they belong to:

```text
delivery-project.propose-change-request
delivery-change-request.decide-change-request
delivery-work-package.plan-deliverable
delivery-deliverable.complete-deliverable
delivery-milestone.request-acceptance
delivery-acceptance-request.record-acceptance
```

Two new capabilities, additive — `delivery-obligations@1`, `delivery-economics@1`
and the whole M13/M14a/M14b1 surface are untouched:

```text
delivery-change-management@1   read-only change requests, revisions and candidates
delivery-acceptance-evidence@1 read-only deliverables, requests and recorded evidence
```

## The commercial boundary, which is the whole risk

A change that costs money must never reach the signed commercial record. So it
does not: approving a `commercial_change_required` request raises an **immutable
candidate** and moves the request to `pending_commercial_followup` — a state a
human can see, not an implicit hop.

A future Commercial Amendment milestone consumes the candidate through the
declared capability, in the package that owns commercial truth. The e2e suite
fingerprints every quote, order, contract and subscription row before and after
and asserts the bytes are identical.

## Acceptance is evidence, not authentication

The strongest claim this milestone makes is:

> a **user actor** recorded that a customer accepted or rejected.

It is **not** an authenticated customer action, not a legal signature, not a
verified identity, and not authorization to bill. There is no customer portal
and nothing is sent anywhere. Real customer actors need the Production Spine.

Completing a deliverable says the work finished. It does **not** say anyone
accepted it — two different facts with two different authors, and conflating
them is how a framework accidentally claims a customer signed off.

## Rejection semantics, decided rather than assumed

A rejected acceptance **preserves execution history**. It is recorded, and
replanning requires a new change request. Completed work packages and
deliverables are never destructively reopened, because rewriting M14a execution
evidence would stop M14b1 economics snapshots reproducing — and a snapshot taken
on Tuesday must still reproduce on Wednesday.

## When each thing is allowed

```text
propose a change      delivery-project in_progress
decide a change       delivery-change-request proposed — exactly once
complete a deliverable  its work package completed (server-authoritative)
request acceptance    every deliverable on the milestone completed,
                      and no other request pending on it
record acceptance     delivery-acceptance-request pending
```

## Evidence is immutable

Every record is `writable: "managed"`: no public create, update or delete
through the service, HTTP, the SDK, the Admin or MCP. A correction is a new
record. A retry under a reused key answers from the stored row only once it has
proved it is the same call — divergent bytes are `409 DELIVERY_EVIDENCE_CONFLICT`
naming the fields that differ.

## Not modeled — stated, not implied

Invoicing, payment, billing eligibility, contract amendment, Quote/Order/Contract
mutation, legal acceptance, authenticated customer identity, customer portal,
external send or notification, e-signature, resource scheduling, capacity,
document or binary storage, SLA, Service, entitlements.

The schema says so in `notModeled`, and the capability descriptions say so where
another package would read them.

## Evidence

`tests/delivery-change-acceptance-e2e.test.js`,
`packages/delivery/src/change-acceptance.js`,
`docs/plans/milestone-14b2-delivery-change-acceptance.md`.
